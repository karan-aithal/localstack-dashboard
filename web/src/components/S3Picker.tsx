/** "Browse S3": walk the instance's buckets and folders to pick an S3 address. */

import { useState } from "react";
import { useAws } from "../aws";

type Buckets = { Buckets?: { Name: string }[] };
type Objects = { CommonPrefixes?: { Prefix: string }[]; Contents?: { Key: string }[]; IsTruncated?: boolean };

export default function S3Picker({ onPick }: { onPick: (uri: string) => void }) {
  const [open, setOpen] = useState(false);
  const [{ bucket, prefix }, setPlace] = useState({ bucket: "", prefix: "" });
  const buckets = useAws<Buckets>("s3", "ListBuckets", {}, open && !bucket);
  // ponytail: first page only (1000 entries per folder); page through it if folders grow larger
  const objects = useAws<Objects>("s3", "ListObjectsV2", { Bucket: bucket, Prefix: prefix, Delimiter: "/" }, open && !!bucket);
  const list = bucket ? objects : buckets;

  const use = (uri: string) => {
    onPick(uri);
    setOpen(false);
  };
  const up = () =>
    setPlace(prefix ? { bucket, prefix: prefix.replace(/[^/]*\/$/, "") } : { bucket: "", prefix: "" });
  const folders = bucket
    ? (objects.data?.result.CommonPrefixes?.map((p) => ({ label: p.Prefix.slice(prefix.length), bucket, prefix: p.Prefix })) ?? [])
    : (buckets.data?.result.Buckets?.map((b) => ({ label: `${b.Name}/`, bucket: b.Name, prefix: "" })) ?? []);
  const files = (bucket && objects.data?.result.Contents?.filter((object) => object.Key !== prefix)) || [];

  return (
    <details className="s3-browse" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Browse S3</summary>
      {bucket && (
        <div className="row">
          <button type="button" onClick={up}>Up</button>
          <code>s3://{bucket}/{prefix}</code>
          <button type="button" onClick={() => use(`s3://${bucket}/${prefix}`)}>Use this folder</button>
        </div>
      )}
      {list.error && <p role="alert" className="bad">{list.error.message}</p>}
      {list.isLoading && <p role="status">Loading…</p>}
      <ul>
        {folders.map((folder) => (
          <li key={folder.label}>
            <button type="button" onClick={() => setPlace({ bucket: folder.bucket, prefix: folder.prefix })}>
              {folder.label}
            </button>
          </li>
        ))}
        {files.map((file) => (
          <li key={file.Key}>
            <button type="button" aria-label={`Use ${file.Key}`} onClick={() => use(`s3://${bucket}/${file.Key}`)}>
              Use
            </button>{" "}
            {file.Key.slice(prefix.length)}
          </li>
        ))}
      </ul>
      {list.data && folders.length + files.length === 0 && (
        <p className="muted">{bucket ? "This folder is empty." : "No buckets."}</p>
      )}
      {bucket && objects.data?.result.IsTruncated && <p className="muted">Only the first 1000 entries are shown.</p>}
    </details>
  );
}
