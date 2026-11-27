/** The commands that push a local image to an ECR repository. */

import { useScope } from "../../api";
import { useAws } from "../../aws";

export default function PushCommands({ ids }: { ids: string[] }) {
  const { region } = useScope();
  const { data, error } = useAws<{ repositories: { repositoryUri: string }[] }>("ecr", "DescribeRepositories", {
    repositoryNames: [ids[0]],
  });
  if (error) return <p role="alert" className="bad">{error.message}</p>;
  if (!data) return <p>Loading…</p>;
  const address = data.result.repositories[0]?.repositoryUri;
  if (!address) return <p className="muted">The repository has no address.</p>;
  const commands = [
    `awslocal ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${address.split("/")[0]}`,
    `docker tag my-image:latest ${address}:latest`,
    `docker push ${address}:latest`,
  ];
  return (
    <>
      <p className="muted">Replace my-image with the name of your local image.</p>
      <pre className="response" tabIndex={0}>{commands.join("\n")}</pre>
    </>
  );
}
