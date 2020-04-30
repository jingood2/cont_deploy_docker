import { Stack, StackProps, Construct, SecretValue } from '@aws-cdk/core';
import { SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs from '@aws-cdk/aws-ecs';
import * as codebuild from '@aws-cdk/aws-codebuild';
import { Bucket, BlockPublicAccess, BucketEncryption } from '@aws-cdk/aws-s3';
import { Duration } from '@aws-cdk/core';
import { ManagedPolicy } from '@aws-cdk/aws-iam';
import { Artifact, Pipeline } from '@aws-cdk/aws-codepipeline';
import {
  GitHubSourceAction, S3DeployAction, LambdaInvokeAction,
  CodeBuildAction, S3SourceAction
} from '@aws-cdk/aws-codepipeline-actions';



export class ContDeployDockerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let sourceOutput: Artifact;
    let source2_Output: Artifact;
    let buildOutput: Artifact;

    //Place resource definitions here.
    var vpc = new Vpc(this, 'my.vpc', {
      cidr: '20.0.0.0/16',
      maxAzs: 2,
      //natGateways: 1,
      subnetConfiguration: [{
        cidrMask: 26,
        name: 'isolatedSubnet',
        subnetType: SubnetType.ISOLATED,
      }],
    });


    // ECR repository
    const ecrRepository = new ecr.Repository(this, "my-ecr-repo", {
      repositoryName: "my-ecr-repo",
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "my-ecs-cluster", {
      vpc: vpc,
      clusterName: "my-ecs-cluster",
    });

  
    var s3Bucket = this.createArtifactBucket("my-s3bucket-" +   Math.floor(Math.random() * Math.floor(999999999)));
    var pipelineProject = this.createPipelineProject(s3Bucket, ecrRepository);
    pipelineProject.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'));

    sourceOutput = new Artifact();
    buildOutput = new Artifact();

    var githubSourceAction = this.createHelloWorldGithubSourceAction(sourceOutput);
    var buildAction = this.createHelloWorldBuildAction(pipelineProject, sourceOutput, buildOutput);

    var pipeline = new Pipeline(this, 'my_pipeline', {
      stages: [
          {
              stageName: 'Source',
              actions: [githubSourceAction]
          },
          {
              stageName: 'Build',
              actions: [buildAction]
          },
          /*
          {
              stageName: 'Deploy',
              actions: [s3DeployAction]
          },

          {
              stageName: 'Notify',
              actions: [postToSlackAction]
          }
          */
      ],
      pipelineName: "my_pipeline",
      //artifactBucket: artifactBucket
  });
  
  }

  // ----------------------- some helper methods -----------------------
  /**
   * create the Pipeline Project wuth Buildspec and stuff
   * @param s3Stack s3Stack where S3 Buckets reside
   */
  private createPipelineProject(s3Bucket: Bucket, ecrRepo: ecr.Repository): codebuild.PipelineProject {
    var pipelineProject = new codebuild.PipelineProject(this, 'my-codepipeline', {
      projectName: "my-codepipeline",
      environment: {
        buildImage: codebuild.LinuxBuildImage.UBUNTU_14_04_OPEN_JDK_8,
        privileged: true
      },
      environmentVariables: {
        'IMAGE_REPO_NAME': {
          value: "hello-world-webapp"
        },
        "IMAGE_TAG": {
          value: "latest"
        },
        "ECR_REPO": {
          value: ecrRepo.repositoryName
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              "#apt-get update -y",
            ],
            finally: [
              "echo Done installing deps"
            ],
          },
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              '$(aws ecr get-login --no-include-email)',
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              './gradlew bootJar',
              'docker build -f docker/Dockerfile -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
              'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $ECR_REPO:$IMAGE_TAG',
              'docker push $ECR_REPO:$IMAGE_TAG'
            ],
            finally: [
              "echo Done building code"
            ],
          },
          post_build: {
            commands: [
              "echo Build completed on `date`"
            ]
          }
        },
        artifacts: {
          files: [
            "build/libs/HelloWorldWebapp-0.0.1-SNAPSHOT.jar"
          ]
        },
        cache: {
          paths: [
            '/root/.gradle/**/*'
          ]
        }
      }),
      cache: codebuild.Cache.bucket(s3Bucket, { prefix: "depsCache" })
    });
    return pipelineProject;
  }

  /**
   * creates a S3 Bucket
   * @param domainName bucketName
   */
  createArtifactBucket(domainName: string) {
    // Content bucket
    return new Bucket(this, domainName, {
      versioned: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: domainName,
      publicReadAccess: false,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [{
        expiration: Duration.days(30)
      }]
    });

  }

  /**
   * creates Github Source
   * @param sourceOutput where to put the clones Repository
   */
  public createHelloWorldGithubSourceAction(sourceOutput: Artifact): GitHubSourceAction {
    return new GitHubSourceAction({
      actionName: 'my_github_source',
      owner: 'logemann',
      repo: 'HelloWorldWebApp',
      oauthToken: SecretValue.secretsManager('github/oauth/token'),
      output: sourceOutput,
      branch: 'master', // default: 'master'
    });
  }

  /**
   * Creates the BuildAction for Codepipeline build step
   * @param pipelineProject pipelineProject to use 
   * @param sourceInput input to build
   * @param buildOutput where to put the ouput
   */
  public createHelloWorldBuildAction(pipelineProject: codebuild.PipelineProject, sourceInput: Artifact,
    buildOutput: Artifact): CodeBuildAction {
    var buildAction = new CodeBuildAction({
      actionName: 'HelloWorldWebAppBuild',
      project: pipelineProject,
      input: sourceInput,
      outputs: [buildOutput],

    });
    return buildAction;
  }

}