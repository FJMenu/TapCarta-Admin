// GitHub push webhook — première étape en lecture seule.
// Cette version vérifie la signature et identifie les applications touchées.
// Elle n'écrit pas encore dans Supabase et ne déclenche aucune publication.

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: {
    get: (key: string) => string | undefined;
  };
};

type GitHubCommit = {
  added?: string[];
  modified?: string[];
  removed?: string[];
};

type GitHubPushPayload = {
  ref?: string;
  after?: string;
  repository?: {
    full_name?: string;
  };
  commits?: GitHubCommit[];
  head_commit?: GitHubCommit | null;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: jsonHeaders,
  });
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }

  return bytes;
}

function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

async function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const suppliedSignature = hexToBytes(
    signatureHeader.slice("sha256=".length),
  );

  if (!suppliedSignature) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const expectedBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody),
  );

  return constantTimeEqual(
    new Uint8Array(expectedBuffer),
    suppliedSignature,
  );
}

function collectChangedFiles(payload: GitHubPushPayload): string[] {
  const changedFiles = new Set<string>();

  const commits = payload.commits ?? [];

  for (const commit of commits) {
    for (
      const file of [
        ...(commit.added ?? []),
        ...(commit.modified ?? []),
        ...(commit.removed ?? []),
      ]
    ) {
      changedFiles.add(file.replaceAll("\\", "/"));
    }
  }

  return [...changedFiles].sort();
}

function detectMasterApplications(changedFiles: string[]): string[] {
  const applications = new Set<string>();

  for (const file of changedFiles) {
    if (file.startsWith("standard-public/")) {
      applications.add("tapcarta-standard");
    }

    if (file.startsWith("resto/")) {
      applications.add("tapcarta-resto");
    }
  }

  return [...applications].sort();
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "method_not_allowed",
    });
  }

  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");

  if (!secret) {
    console.error("GITHUB_WEBHOOK_SECRET is missing.");

    return jsonResponse(500, {
      ok: false,
      error: "server_configuration_error",
    });
  }

  const rawBody = await req.text();

  const signatureValid = await verifyGitHubSignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    secret,
  );

  if (!signatureValid) {
    return jsonResponse(401, {
      ok: false,
      error: "invalid_signature",
    });
  }

  const eventName = req.headers.get("x-github-event");

  if (eventName === "ping") {
    return jsonResponse(200, {
      ok: true,
      event: "ping",
    });
  }

  if (eventName !== "push") {
    return jsonResponse(202, {
      ok: true,
      ignored: true,
      reason: "unsupported_event",
      event: eventName,
    });
  }

  let payload: GitHubPushPayload;

  try {
    payload = JSON.parse(rawBody) as GitHubPushPayload;
  } catch {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_json",
    });
  }

  if (payload.ref !== "refs/heads/main") {
    return jsonResponse(202, {
      ok: true,
      ignored: true,
      reason: "non_production_branch",
      ref: payload.ref ?? null,
    });
  }

  const repository = payload.repository?.full_name ?? "";
  const commitSha = payload.after ?? "";
  const changedFiles = collectChangedFiles(payload);

  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_commit_sha",
    });
  }

  if (repository !== "FJMenu/tapcarta-master") {
    return jsonResponse(202, {
      ok: true,
      ignored: true,
      reason: "repository_not_enabled_yet",
      repository,
      commit_sha: commitSha,
    });
  }

  const affectedApplications = detectMasterApplications(changedFiles);

  return jsonResponse(200, {
    ok: true,
    dry_run: true,
    repository,
    ref: payload.ref,
    commit_sha: commitSha,
    changed_files: changedFiles,
    affected_applications: affectedApplications,
    message:
      "Signature validée. Aucun UUID créé et aucune publication déclenchée.",
  });
});
