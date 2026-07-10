import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { downloadArtifactBlob } from "../api";

interface AuthenticatedArtifactLinkProps {
  artifactUrl?: string;
  children: ReactNode;
  filename?: string;
  mode?: "open" | "download";
  className?: string;
}

function filenameFromArtifact(artifactUrl: string) {
  return artifactUrl.split("/").filter(Boolean).at(-1) ?? "artifact";
}

function isHtmlArtifact(artifactUrl: string, blob: Blob) {
  return artifactUrl.endsWith(".html") || blob.type.includes("text/html");
}

async function htmlWithAuthenticatedImageUrls(html: string) {
  const objectUrls: string[] = [];
  const artifactUrls = Array.from(
    new Set(Array.from(html.matchAll(/(<img\b[^>]*\bsrc=["'])(\/artifacts\/[^"']+)(["'][^>]*>)/g)).map((match) => match[2]))
  );
  let rewritten = html;
  for (const artifactUrl of artifactUrls) {
    try {
      const imageBlob = await downloadArtifactBlob(artifactUrl);
      const imageUrl = URL.createObjectURL(imageBlob);
      objectUrls.push(imageUrl);
      rewritten = rewritten.split(artifactUrl).join(imageUrl);
    } catch {
      // Keep the original src visible in the HTML if an image cannot be fetched.
    }
  }
  return {
    blob: new Blob([rewritten], { type: "text/html" }),
    objectUrls
  };
}

export function AuthenticatedArtifactLink({
  artifactUrl,
  children,
  filename,
  mode = "open",
  className
}: AuthenticatedArtifactLinkProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openArtifact() {
    if (!artifactUrl) return;
    setBusy(true);
    setError(null);
    const targetWindow = mode === "open" ? window.open("", "_blank", "noopener,noreferrer") : null;
    try {
      const blob = await downloadArtifactBlob(artifactUrl);
      const htmlArtifact = mode === "open" && isHtmlArtifact(artifactUrl, blob)
        ? await htmlWithAuthenticatedImageUrls(await blob.text())
        : undefined;
      const objectUrl = URL.createObjectURL(htmlArtifact?.blob ?? blob);
      if (mode === "download") {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename ?? filenameFromArtifact(artifactUrl);
        document.body.append(link);
        link.click();
        link.remove();
      } else if (targetWindow) {
        targetWindow.location.href = objectUrl;
      } else {
        window.open(objectUrl, "_blank", "noopener,noreferrer");
      }
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        for (const embeddedUrl of htmlArtifact?.objectUrls ?? []) URL.revokeObjectURL(embeddedUrl);
      }, 60_000);
    } catch (caught) {
      if (targetWindow) targetWindow.close();
      setError(caught instanceof Error ? caught.message : "artifact download failed");
    } finally {
      setBusy(false);
    }
  }

  if (!artifactUrl) return null;
  return (
    <>
      <button className={className ?? "artifact-link"} disabled={busy} onClick={openArtifact} type="button">
        {busy ? "加载中..." : children}
      </button>
      {error && <span className="artifact-link-error">{error}</span>}
    </>
  );
}

export function AuthenticatedArtifactImage({ artifactUrl, alt }: { artifactUrl?: string; alt: string }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let localUrl: string | null = null;
    setObjectUrl(null);
    setError(null);
    if (!artifactUrl) return undefined;
    downloadArtifactBlob(artifactUrl)
      .then((blob) => {
        if (!active) return;
        localUrl = URL.createObjectURL(blob);
        setObjectUrl(localUrl);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "image download failed");
      });
    return () => {
      active = false;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [artifactUrl]);

  if (!artifactUrl) return null;
  if (error) {
    return <div className="live-view-error">截图加载失败：{error}</div>;
  }
  return objectUrl ? <img src={objectUrl} alt={alt} /> : <div className="live-view-error">正在加载截图...</div>;
}
