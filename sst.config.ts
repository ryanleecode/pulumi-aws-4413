/// <reference path="./.sst/platform/config.d.ts" />

import { Restate } from "./infra/restate";

export default $config({
  app(input) {
    return {
      name: "pulumi-aws-4413",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const vpc = setupVPC();

    const cluster = new sst.aws.Cluster("Cluster3", {
      vpc: {
        id: vpc.id,
        publicSubnets: vpc.publicSubnets,
        privateSubnets: vpc.privateSubnets,
        securityGroups: vpc.securityGroups,
      },
    });

    const restate = new Restate("Restate", {
      vpc,
      cluster: cluster.nodes.cluster,
    });
  },
});

function setupVPC() {
  const vpc = new sst.aws.Vpc("VPC");
  if ($dev) return vpc;

  const fckNatSg = new aws.ec2.SecurityGroup("FckNatSecurityGroup", {
    vpcId: vpc.id,
    egress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    ingress: [
      {
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        cidrBlocks: ["0.0.0.0/0", vpc.nodes.vpc.cidrBlock],
      },
    ],
  });

  // https://fck-nat.dev/stable/
  const fckNatInstance = new aws.ec2.Instance("FckNatInstance", {
    ami: "ami-075a0093cd9926d44",
    instanceType: "t4g.nano",
    associatePublicIpAddress: true,
    subnetId: $util.output(vpc.publicSubnets).apply((subnets) => subnets[0]),
    vpcSecurityGroupIds: [fckNatSg.id],
    sourceDestCheck: false,
  });

  vpc.nodes.privateRouteTables.apply((routeTables) => {
    routeTables.forEach((routeTable, i) => {
      new aws.ec2.Route(`FckNatRoute-${i}`, {
        routeTableId: routeTable.id,
        destinationCidrBlock: "0.0.0.0/0",
        networkInterfaceId: fckNatInstance.primaryNetworkInterfaceId,
      });
    });
  });

  return vpc;
}
