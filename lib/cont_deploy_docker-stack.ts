import { Stack, StackProps, Construct, SecretValue } from '@aws-cdk/core';
import { Vpc } from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecspatterns from '@aws-cdk/aws-ecs-patterns';
import * as codebuild from '@aws-cdk/aws-codebuild';
import { Bucket, BlockPublicAccess, BucketEncryption } from '@aws-cdk/aws-s3';
import { Duration } from '@aws-cdk/core';
import { ManagedPolicy } from '@aws-cdk/aws-iam';
import { Artifact, Pipeline } from '@aws-cdk/aws-codepipeline';
import {
  GitHubSourceAction, S3DeployAction, LambdaInvokeAction,
  CodeBuildAction, S3SourceAction, EcsDeployAction
} from '@aws-cdk/aws-codepipeline-actions';


const repoName = "hello-world-webapp";

export class ContDeployDockerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    let sourceOutput: Artifact;
    let source2_Output: Artifact;
    let buildOutput: Artifact;


    //Place resource definitions here.
    var vpc = new Vpc(this, 'my.vpc', {
      cidr: '10.0.0.0/16',
      maxAzs: 2
    });


    // ECR repository
    const ecrRepository = new ecr.Repository(this, repoName, {
      repositoryName: repoName,
    });


    var s3Bucket = this.createArtifactBucket("my-s3bucket", "my-s3bucket-" + this.account);
    var pipelineProject = this.createPipelineProject(s3Bucket, ecrRepository);
    pipelineProject.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'));

    sourceOutput = new Artifact();
    buildOutput = new Artifact();

    var githubSourceAction = this.createHelloWorldGithubSourceAction(sourceOutput);
    var buildAction = this.createHelloWorldBuildAction(pipelineProject, sourceOutput, buildOutput);
    var ecsDeployAction = this.createEcsDeployAction(vpc, ecrRepository, buildOutput);

    var pipeline = new Pipeline(this, 'my_pipeline_', {
      stages: [
        {
          stageName: 'Source',
          actions: [githubSourceAction]
        },
        {
          stageName: 'Build',
          actions: [buildAction]
        },
        {
          stageName: 'Deploy',
          actions: [ecsDeployAction]
        },
        /*
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
        "ECR_REPO": {
          value: ecrRepo.repositoryUriForTag()
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
              'COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
              'IMAGE_TAG=${COMMIT_HASH:=latest}'
            ],
          },
          build: {
            commands: [
              'echo Build started on `date`',
              './gradlew bootJar',
              'echo Building Docker Image $ECR_REPO:latest',
              'docker build -f docker/Dockerfile -t $ECR_REPO:latest .',
              'echo Tagging Docker Image $ECR_REPO:latest with $ECR_REPO:$IMAGE_TAG',
              'docker tag $ECR_REPO:latest $ECR_REPO:$IMAGE_TAG',
              'echo Pushing Docker Image to $ECR_REPO:latest and $ECR_REPO:$IMAGE_TAG',
              'docker push $ECR_REPO:latest',
              'docker push $ECR_REPO:$IMAGE_TAG'
            ],
            finally: [
              "echo Done building code"
            ],
          },
          post_build: {
            commands: [
              "echo creating imagedefinitions.json dynamically",
              "printf '[{\"name\":\"" + repoName + "\",\"imageUri\": \""+ ecrRepo.repositoryUriForTag() + ":latest\"}]' > imagedefinitions.json",
              "echo Build completed on `date`"
            ]
          }
        },
        artifacts: {
          files: [
            "imagedefinitions.json"
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
  createArtifactBucket(id: string, buckeName: string) {
    // Content bucket
    return new Bucket(this, id, {
      versioned: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      bucketName: buckeName,
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
   * @param sourceActionOutput input to build
   * @param buildOutput where to put the ouput
   */
  public createHelloWorldBuildAction(pipelineProject: codebuild.PipelineProject, sourceActionOutput: Artifact,
    buildOutput: Artifact): CodeBuildAction {
    var buildAction = new CodeBuildAction({
      actionName: 'HelloWorldWebAppBuild',
      project: pipelineProject,
      input: sourceActionOutput,
      outputs: [buildOutput],

    });
    return buildAction;
  }

  public createEcsDeployAction(vpc: Vpc, ecrRepo: ecr.Repository, buildOutput : Artifact): EcsDeployAction {
    return new EcsDeployAction({
      actionName: 'EcsDeployAction',
      service: this.createLoadBalancedFargateService(this, vpc, ecrRepo).service,
      input: buildOutput,
    })
  };


  createLoadBalancedFargateService(scope: Construct, vpc: Vpc, ecrRepository: ecr.Repository) {
    return new ecspatterns.ApplicationLoadBalancedFargateService(scope, 'myLbFargateService', {
      vpc: vpc,
      memoryLimitMiB: 512,
      cpu: 256,
      assignPublicIp: true,
      // listenerPort: 8080,  
      taskImageOptions: {
        containerName: repoName,
        image: ecs.ContainerImage.fromEcrRepository(ecrRepository, "latest"),
        containerPort: 8080,
      },
    });
  }

}