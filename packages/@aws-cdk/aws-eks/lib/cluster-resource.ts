import cfn = require('@aws-cdk/aws-cloudformation');
import { PolicyStatement } from '@aws-cdk/aws-iam';
import iam = require('@aws-cdk/aws-iam');
import lambda = require('@aws-cdk/aws-lambda');
import { Runtime, RuntimeFamily } from "@aws-cdk/aws-lambda";
import { Construct, Duration, Token } from '@aws-cdk/core';
import path = require('path');
import { CfnClusterProps } from './eks.generated';
import { KubectlLayer } from './kubectl-layer';

export interface ClusterResourceProps extends CfnClusterProps {
  /**
   * Tags to apply to the stack resource
   */
  readonly tags?: { [key: string]: string };

}

/**
 * A low-level CFN resource Amazon EKS cluster implemented through a custom
 * resource.
 *
 * Implements EKS create/update/delete through a CloudFormation custom resource
 * in order to allow us to control the IAM role which creates the cluster. This
 * is required in order to be able to allow CloudFormation to interact with the
 * cluster via `kubectl` to enable Kubernetes management capabilities like apply
 * manifest and IAM role/user RBAC mapping.
 */
export class ClusterResource extends Construct {
  /**
   * The AWS CloudFormation resource type used for this resource.
   */
  public static readonly RESOURCE_TYPE = 'Custom::AWSCDK-EKS-Cluster';

  public readonly attrEndpoint: string;
  public readonly attrArn: string;
  public readonly attrCertificateAuthorityData: string;
  public readonly ref: string;

  /**
   * The IAM role which created the cluster. Initially this is the only IAM role
   * that gets administrator privilages on the cluster (`system:masters`), and
   * will be able to issue `kubectl` commands against it.
   */
  public readonly creationRole: iam.IRole;

  constructor(scope: Construct, id: string, props: ClusterResourceProps) {
    super(scope, id);

    // each cluster resource will have it's own lambda handler since permissions
    // are scoped to this cluster and related resources like it's role
    const handler = new lambda.Function(this, 'ResourceHandler', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'cluster-resource')),
      runtime: new Runtime('python3.8',      RuntimeFamily.PYTHON, { supportsInlineCode: true }),
      handler: 'index.handler',
      timeout: Duration.minutes(15),
      memorySize: 512,
      layers: [ KubectlLayer.getOrCreate(this) ],
    });

    if (!props.roleArn) {
      throw new Error(`"roleArn" is required`);
    }

    // since we don't know the cluster name at this point, we must give this role star resource permissions
    handler.addToRolePolicy(new PolicyStatement({
      actions: [ 'eks:CreateCluster', 'eks:DescribeCluster', 'eks:DeleteCluster', 'eks:UpdateClusterVersion' ],
      resources: [ '*' ]
    }));

    // the CreateCluster API will allow the cluster to assume this role, so we
    // need to allow the lambda execution role to pass it.
    handler.addToRolePolicy(new PolicyStatement({
      actions: [ 'iam:PassRole' ],
      resources: [ props.roleArn ]
    }));

    const resource = new cfn.CustomResource(this, 'Resource', {
      resourceType: ClusterResource.RESOURCE_TYPE,
      provider: cfn.CustomResourceProvider.lambda(handler),
      properties: {
        Config: props
      }
    });

    this.ref = resource.ref;
    this.attrEndpoint = Token.asString(resource.getAtt('Endpoint'));
    this.attrArn = Token.asString(resource.getAtt('Arn'));
    this.attrCertificateAuthorityData = Token.asString(resource.getAtt('CertificateAuthorityData'));
    this.creationRole = handler.role!;
  }
}