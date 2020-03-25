from aws_cdk import core
import aws_cdk.aws_codebuild as codebuild


class BuildProject():
    def __init__(self, scope: core.Construct, role, stage, context=None):
        self.scope = scope
        self.role = role
        self.stage = stage
        self.context = context

    def pipeline_project(self):
        project_name = f"{self.stage}Project"
        env = {'build_image': codebuild.LinuxBuildImage.STANDARD_2_0}
        env_vars = {
            'CI': {'value': 'true', 'type': codebuild.BuildEnvironmentVariableType.PLAINTEXT},
            'STAGE': {'value': self.stage, 'type': codebuild.BuildEnvironmentVariableType.PLAINTEXT},
        }
        artifacts = {
            'files': [
                'cdk.out/*',
                'scripts/codebuild/**/*'
            ],
        }
        return codebuild.PipelineProject(self.scope, project_name, role=self.role, environment=env, environment_variables=env_vars,
                    build_spec=codebuild.BuildSpec.from_object({'version': '0.2', 'phases': self._get_phases(), 'artifacts': artifacts}))

    def _get_phases(self):
        return {
            'install': {
                'runtime-versions': {
                    'python': 3.8,
                },
                'commands': [
                    'echo "Ensure that the codebuild directory is executable"',
                    'chmod -R 755 ./scripts/codebuild/*',
                    './scripts/codebuild/install.sh'
                ],
            },
            'pre_build': {
                'commands': [f"./scripts/codebuild/pre_build.sh {self.context['es_stackname']}-{self.stage}"],
            },
            'build': {
                'commands': ['./scripts/codebuild/deploy.sh'],
            },
            'post_build': {
                'commands': ['./scripts/codebuild/post_build.sh'],
            },
        }
