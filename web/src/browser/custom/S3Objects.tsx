import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { instancePath, useInstance, useScope } from "../../api";
import { readBase64, type Result, useAws, useAwsCall, useRefresh } from "../../aws";
import { href } from "../../engine";
import type { Params } from "../../params";

// ponytail: uploads travel as one base64 request; use multipart upload if larger files are needed
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const PREVIEW_BYTES = 64 * 1024;

type Listing = {
  CommonPrefixes?: { Prefix: string }[];
  Contents?: { Key: string; LastModified: string; Size: number }[];
};

export default function S3Objects({ ids }: { ids: string[] }) {
  const bucket = ids[0];
  const [query] = useSearchParams();
  const prefix = query.get("prefix") ?? "";
  const instance = useInstance();
  const scope = useScope();
  const call = useAwsCall();
  const refresh = useRefresh();
  const [token, setToken] = useState<Params>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ key: string; text: string }>();
  const list = useAws<Listing>("s3", "ListObjectsV2", { Bucket: bucket, Prefix: prefix, Delimiter: "/", ...token });

  const folders = list.data?.result.CommonPrefixes?.map((p) => p.Prefix) ?? [];
  // the marker object of the open folder is the folder itself, not a file in it
  const files = list.data?.result.Contents?.filter((object) => object.Key !== prefix) ?? [];
  const at = (to: string) => href("s3", "buckets", [bucket, "objects"], to ? { prefix: to } : {});

  const upload = useMutation({
    mutationFn: async (chosen: File[]) => {
      const tooBig = chosen.find((file) => file.size > UPLOAD_LIMIT);
      if (tooBig) throw new Error(`${tooBig.name} is larger than 50 MB. Use the AWS CLI for large files.`);
      for (const file of chosen) {
        await call("s3", "PutObject", {
          Bucket: bucket,
          Key: prefix + file.name,
          Body: await readBase64(file),
          ...(file.type && { ContentType: file.type }),
        });
      }
    },
    onSettled: refresh,
  });
  const createFolder = useMutation({
    mutationFn: (name: string) => call("s3", "PutObject", { Bucket: bucket, Key: `${prefix}${name}/` }),
    onSuccess: refresh,
  });
  /** Every key below a folder, across all pages. */
  const keysBelow = async (folder: string) => {
    const keys: string[] = [];
    let next: Params | null = {};
    while (next) {
      const page: Result<Listing> = await call<Listing>("s3", "ListObjectsV2", { Bucket: bucket, Prefix: folder, ...next });
      keys.push(...(page.result.Contents?.map((object) => object.Key) ?? []));
      next = page.next;
    }
    return keys;
  };
  const remove = useMutation({
    mutationFn: async (chosen: string[]) => {
      // a selected folder stands for every object below it
      const keys: string[] = [];
      for (const entry of chosen) keys.push(...(entry.endsWith("/") ? await keysBelow(entry) : [entry]));
      if (!window.confirm(`Delete ${keys.length} objects from bucket "${bucket}"? This cannot be undone.`)) return;
      for (let i = 0; i < keys.length; i += 1000) {
        const Objects = keys.slice(i, i + 1000).map((Key) => ({ Key }));
        const { result } = await call<{ Errors?: { Key: string; Message: string }[] }>("s3", "DeleteObjects", {
          Bucket: bucket,
          Delete: { Objects, Quiet: true },
        });
        if (result.Errors?.length) throw new Error(result.Errors.map((e) => `${e.Key}: ${e.Message}`).join("\n"));
      }
      setSelected(new Set());
    },
    onSettled: refresh,
  });
  const view = useMutation({
    mutationFn: async ({ key, size }: { key: string; size: number }) => {
      if (size === 0) return { key, text: "(empty)" };
      const { result } = await call<{ Body: { text?: string } }>("s3", "GetObject", {
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${PREVIEW_BYTES - 1}`,
      });
      if (result.Body.text === undefined) return { key, text: "Binary content. Download to open it." };
      return { key, text: result.Body.text + (size > PREVIEW_BYTES ? "\n… (first 64 KB shown)" : "") };
    },
    onSuccess: setPreview,
  });

  const toggle = (key: string, on: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const turn = (to: Params | undefined) => {
    setSelected(new Set());
    setToken(to);
  };
  const submitFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    createFolder.mutate(String(new FormData(form).get("folder")), { onSuccess: () => form.reset() });
  };
  const check = (key: string) => (
    <td className="check">
      <input type="checkbox" aria-label={`Select ${key}`} checked={selected.has(key)} onChange={(e) => toggle(key, e.target.checked)} />
    </td>
  );
  const copy = (key: string) => (
    <button onClick={() => navigator.clipboard.writeText(`s3://${bucket}/${key}`)}>Copy S3 URI</button>
  );
  const parts = prefix.split("/").slice(0, -1);
  const error = list.error ?? upload.error ?? createFolder.error ?? remove.error ?? view.error;

  return (
    <>
      <nav aria-label="Folder path" className="crumbs">
        <ol>
          <li><Link to={at("")}>{bucket}</Link></li>
          {parts.map((part, i) => (
            <li key={i}><Link to={at(`${parts.slice(0, i + 1).join("/")}/`)}>{part || "(empty)"}</Link></li>
          ))}
        </ol>
      </nav>
      <div className="row">
        <label className="button primary">
          {upload.isPending ? "Uploading…" : "Upload files"}
          <input type="file" multiple className="hidden-file" disabled={upload.isPending}
            onChange={(e) => {
              upload.mutate([...(e.target.files ?? [])]);
              e.target.value = "";
            }} />
        </label>
        <form className="inline" onSubmit={submitFolder}>
          <input name="folder" aria-label="New folder name" placeholder="New folder name" required pattern="[^\/]+" />
          <button disabled={createFolder.isPending}>Create folder</button>
        </form>
        <button onClick={() => list.refetch()} disabled={list.isFetching}>Refresh</button>
        <button className="danger" disabled={selected.size === 0 || remove.isPending} onClick={() => remove.mutate([...selected])}>
          Delete selected ({selected.size})
        </button>
      </div>
      {error && <p role="alert" className="bad lines">{error.message}</p>}
      <div className="scroll">
        <table>
          <thead>
            <tr><th className="check"></th><th>Key</th><th>Last modified</th><th>Size</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {folders.map((folder) => (
              <tr key={folder}>
                {check(folder)}
                <td><Link to={at(folder)}>{folder.slice(prefix.length)}</Link></td>
                <td></td>
                <td></td>
                <td className="actions">{copy(folder)}</td>
              </tr>
            ))}
            {files.map((file) => (
              <tr key={file.Key}>
                {check(file.Key)}
                <td>{file.Key.slice(prefix.length)}</td>
                <td>{file.LastModified}</td>
                <td>{file.Size.toLocaleString()} B</td>
                <td className="actions">
                  <button onClick={() => view.mutate({ key: file.Key, size: file.Size })}>View</button>
                  <a className="button" download href={instancePath(instance, `/s3/download?${new URLSearchParams({ bucket, key: file.Key, ...scope })}`)}>
                    Download
                  </a>
                  {copy(file.Key)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && folders.length + files.length === 0 && <p className="muted">This folder is empty.</p>}
      {(token || list.data?.next) && (
        <div className="row">
          <button disabled={!token} onClick={() => turn(undefined)}>First page</button>
          <button disabled={!list.data?.next} onClick={() => turn(list.data!.next!)}>Next page</button>
        </div>
      )}
      {preview && (
        <section aria-label="Preview">
          <div className="row">
            <h2>{preview.key}</h2>
            <button onClick={() => setPreview(undefined)}>Close preview</button>
          </div>
          <pre className="response" tabIndex={0}>{preview.text}</pre>
        </section>
      )}
    </>
  );
}
