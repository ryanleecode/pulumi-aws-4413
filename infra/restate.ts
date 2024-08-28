import * as pulumi from "@pulumi/pulumi";

export interface RestateProps {
  vpc: $util.Input<{
    /**
     * The ID of the VPC.
     */
    id: $util.Input<string>;
    /**
     * A list of public subnet IDs in the VPC. If a service has public ports configured,
     * its load balancer will be placed in the public subnets.
     */
    publicSubnets: $util.Input<$util.Input<string>[]>;
    /**
     * A list of private subnet IDs in the VPC. The service will be placed in the private
     * subnets.
     */
    privateSubnets: $util.Input<$util.Input<string>[]>;
    /**
     * A list of VPC security group IDs for the service.
     */
    securityGroups: $util.Input<$util.Input<string>[]>;
  }>;
  cluster: $util.Input<{
    /**
     * The name of the cluster.
     */
    name: $util.Input<string>;
    /**
     * The ARN of the cluster.
     */
    arn: $util.Input<string>;
  }>;
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  minCapacity?: number;
  maxCapacity?: number;
}

export class Restate extends pulumi.ComponentResource {
  public readonly service: aws.ecs.Service;
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly target: aws.appautoscaling.Target;
  public readonly scalingPolicy: aws.appautoscaling.Policy;

  constructor(
    name: string,
    args: RestateProps,
    opts?: $util.ComponentResourceOptions
  ) {
    super("custom:index:Restate", name, args, opts);

    const self = this;

    const cluster = $util.output(args.cluster);
    const vpc = $util.output(args.vpc);

    const logGroup = createLogGroup();

    const taskRole = new aws.iam.Role(
      `${name}TaskRole`,
      {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "ecs-tasks.amazonaws.com",
        }),
      },
      { parent: self }
    );

    const executionRole = new aws.iam.Role(
      `${name}ExecutionRole`,
      {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "ecs-tasks.amazonaws.com",
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        ],
      },
      { parent: self }
    );

    this.taskDefinition = new aws.ecs.TaskDefinition(
      `${name}TaskDefinition`,
      {
        family: $interpolate`${cluster.name}-${name}`,
        trackLatest: true,
        cpu: args.cpu?.toString() || "0.25 vCPU",
        memory: args.memory?.toString() || "0.5 GB",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        executionRoleArn: executionRole.arn,
        taskRoleArn: taskRole.arn,
        containerDefinitions: $jsonStringify([
          {
            name: "restate",
            image: "restatedev/restate:latest",
            portMappings: [{ containerPort: 8080 }, { containerPort: 9070 }],
            healthCheck: {
              retries: 3,
              command: [
                "CMD",
                "/bin/bash",
                "-c",
                "function simple_curl() { local host=\"$1\"; local port=\"$2\"; local path=\"$3\"; exec 3<>/dev/tcp/$host/$port; echo -e \"GET $path HTTP/1.1\\r\\nHost: $host\\r\\nConnection: close\\r\\n\\r\\n\" >&3; while IFS= read -r line <&3; do if [[ \"$line\" =~ ^HTTP/1\\.1[[:space:]]([0-9]{3}) ]]; then echo \"${BASH_REMATCH[1]}\"; break; fi; done; exec 3>&-; }; status=$(simple_curl localhost 8080 /restate/health); if [[ \"$status\" == \"200\" ]]; then echo \"Health check passed\"; exit 0; else echo \"Health check failed with status $status\"; exit 1; fi"
              ],
              timeout: 5,
              interval: 30,
              startPeriod: 30,
            },
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroup.name,
                "awslogs-region": aws.config.region,
                "awslogs-stream-prefix": "/service",
              },
            },
            mountPoints: [
              {
                sourceVolume: "restate-data",
                containerPath: "/restate-data",
                readOnly: false,
              },
            ],
          },
        ]),
        volumes: [
          {
            name: "restate-data",
            configureAtLaunch: true
          } ,
        ],
      },
      { parent: self }
    );

    const ecsVolumeRole = new aws.iam.Role(
      `${name}ECSVolumeRole`,
      {
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: [
                  "ecs-tasks.amazonaws.com",
                  "ecs.amazonaws.com"
                ]
              },
              Action: "sts:AssumeRole"
            }
          ]
        }),
      },
      { parent: self }
    );

    new aws.iam.RolePolicyAttachment(
      `${name}ECSVolumePolicyAttachment`,
      {
        role: ecsVolumeRole.name,
        policyArn:
          "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForVolumes",
      },
      { parent: self }
    );

    this.service = new aws.ecs.Service(
      `${name}Service`,
      {
        cluster: cluster.arn,
        taskDefinition: this.taskDefinition.arn,
        desiredCount: args.desiredCount || 1,
        launchType: "FARGATE",
        networkConfiguration: {
          assignPublicIp: false,
          subnets: vpc.privateSubnets,
          securityGroups: vpc.securityGroups,
        },
        deploymentCircuitBreaker: {
          enable: true,
          rollback: true,
        },
        volumeConfiguration: {
          name: "restate-data",
          managedEbsVolume: {
            roleArn: ecsVolumeRole.arn,
            encrypted: true,
            fileSystemType: "ext4",
            iops: 3000,
            sizeInGb: 20,
            throughput: 125,
            volumeType: "gp3",
          },
        },
      },
      { parent: self }
    );

    this.target = new aws.appautoscaling.Target(
      `${name}AutoScalingTarget`,
      {
        serviceNamespace: "ecs",
        scalableDimension: "ecs:service:DesiredCount",
        resourceId: $util.interpolate`service/${cluster.name}/${this.service.name}`,
        maxCapacity: args.maxCapacity || 10,
        minCapacity: args.minCapacity || 1,
      },
      { parent: self }
    );

    this.scalingPolicy = new aws.appautoscaling.Policy(
      `${name}AutoScalingCpuPolicy`,
      {
        serviceNamespace: this.target.serviceNamespace,
        scalableDimension: this.target.scalableDimension,
        resourceId: this.target.resourceId,
        policyType: "TargetTrackingScaling",
        targetTrackingScalingPolicyConfiguration: {
          predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
          targetValue: 75,
          scaleInCooldown: 300,
          scaleOutCooldown: 300,
        },
      },
      { parent: self }
    );

    this.registerOutputs({
      service: this.service,
      taskDefinition: this.taskDefinition,
      scalableTarget: this.target,
      scalingPolicy: this.scalingPolicy,
    });

    function createLogGroup() {
      return new aws.cloudwatch.LogGroup(
        `${name}LogGroup`,
        {
          name: $util.interpolate`/sst/cluster/${cluster.name}/${name}`,
          retentionInDays: 0,
        },
        { parent: self }
      );
    }
  }
}
