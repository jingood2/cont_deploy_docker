import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as ContDeployDocker from '../lib/cont_deploy_docker-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new ContDeployDocker.ContDeployDockerStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
