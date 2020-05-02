import { Stack, StackProps, Construct, SecretValue } from '@aws-cdk/core';
import { Vpc } from '@aws-cdk/aws-ec2';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecspatterns from '@aws-cdk/aws-ecs-patterns';
import * as codebuild from '@aws-cdk/aws-codebuild';
import { ManagedPolicy } from '@aws-cdk/aws-iam';
import { Artifact, Pipeline } from '@aws-cdk/aws-codepipeline';
import { GitHubSourceAction, CodeBuildAction, EcsDeployAction} from '@aws-cdk/aws-codepipeline-actions';
import { PipelineProject, LocalCacheMode } from '@aws-cdk/aws-codebuild';


const repoName = "hello-world-webapp";

export class ContDeployDockerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    var oauthToken = SecretValue.secretsManager('github/oauth/token');

    let sourceOutput: Artifact;
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

    var pipelineProject = this.createPipelineProject(ecrRepository);
    pipelineProject.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser'));

    sourceOutput = new Artifact();
    buildOutput = new Artifact();

    var githubSourceAction = this.createHelloWorldGithubSourceAction(sourceOutput, oauthToken);
    var buildAction = this.createHelloWorldBuildAction(pipelineProject, sourceOutput, buildOutput);
    var ecsDeployAction = this.createEcsDeployAction(vpc, ecrRepository, buildOutput, pipelineProject);

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
      ],
      pipelineName: "my_pipeline",
      //artifactBucket: artifactBucket
    });

  }

  // ----------------------- some helper methods -----------------------
  /**
   * create the Pipeline Project wuth Buildspec and stuff
   */
  private createPipelineProject(ecrRepo: ecr.Repository): codebuild.PipelineProject {
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
              "printf '[{\"name\":\"" + repoName + "\",\"imageUri\": \"" + ecrRepo.repositoryUriForTag() + ":latest\"}]' > imagedefinitions.json",
              //'XX="$(ls -l /root/.gradle/)"; printf "%s\n" "$XX"',
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
            '/root/.gradle/**/*',
          ]
       }
      }),
      cache: codebuild.Cache.local(LocalCacheMode.DOCKER_LAYER, LocalCacheMode.CUSTOM)
    });
    return pipelineProject;
  }

  /**
   * creates Github Source
   * @param sourceOutput where to put the clones Repository
   */
  public createHelloWorldGithubSourceAction(sourceOutput: Artifact, oauthToken: SecretValue): GitHubSourceAction {
    return new GitHubSourceAction({
      actionName: 'my_github_source',
      owner: 'logemann',
      repo: 'HelloWorldWebApp',
      oauthToken: oauthToken,
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

  public createEcsDeployAction(vpc: Vpc, ecrRepo: ecr.Repository, buildOutput: Artifact, pipelineProject: PipelineProject): EcsDeployAction {
    return new EcsDeployAction({
      actionName: 'EcsDeployAction',
      service: this.createLoadBalancedFargateService(this, vpc, ecrRepo, pipelineProject).service,
      input: buildOutput,
    })
  };

  createLoadBalancedFargateService(scope: Construct, vpc: Vpc, ecrRepository: ecr.Repository, pipelineProject: PipelineProject) {
    var fargateService = new ecspatterns.ApplicationLoadBalancedFargateService(scope, 'myLbFargateService', {
      vpc: vpc,
      memoryLimitMiB: 512,
      cpu: 256,
      assignPublicIp: true,
      // listenerPort: 8080,  
      taskImageOptions: {
        containerName: repoName,
        image: ecs.ContainerImage.fromRegistry("hello-world"),
        containerPort: 8080,
      },
    });
    fargateService.taskDefinition.executionRole?.addManagedPolicy((ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryPowerUser')));
    return fargateService;
  }
}