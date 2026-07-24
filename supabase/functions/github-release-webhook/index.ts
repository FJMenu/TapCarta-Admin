// GitHub push webhook — création technique des publications.
// Vérité technique : UUID + application + SHA GitHub.
// La version V... reste un simple libellé visuel humain.

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
};

type ExistingRelease = {
  id: string;
  app_key: string;
  version: string;
  release_commit_sha: string | null;
  release_status: string;
  created_at: string;
};

type CreatedRelease = ExistingRelease & {
  stabilization_started_at: string | null;
  stabilization_ends_at: string | null;
};

const STABILIZATION_MINUTES = 120;

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

  for (const commit of payload.commits ?? []) {
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

const MASTER_REPOSITORY = "fjmenu/tapcarta-master";
const PUBLIC_REPOSITORY = "fjmenu/tapcarta-public";
const ADMIN_REPOSITORY = "fjmenu/tapcarta-admin";

const SHARED_DEPLOYMENT_FILES = new Set([
  "vercel.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function isRepositoryMetadataOnly(file: string): boolean {
  const normalizedFile = file.toLowerCase();

  return normalizedFile === "readme.md" ||
    normalizedFile === ".gitignore" ||
    normalizedFile.startsWith(".github/") ||
    normalizedFile.startsWith(".vscode/") ||
    normalizedFile.startsWith("docs/") ||
    normalizedFile.startsWith("supabase/");
}

function detectMasterApplications(changedFiles: string[]): string[] {
  const applications = new Set<string>();

  for (const file of changedFiles) {
    const normalizedFile = file.toLowerCase();

    if (isRepositoryMetadataOnly(normalizedFile)) {
      continue;
    }

    if (SHARED_DEPLOYMENT_FILES.has(normalizedFile)) {
      applications.add("tapcarta-standard");
      applications.add("tapcarta-resto");
      continue;
    }

    if (normalizedFile.startsWith("standard-public/")) {
      applications.add("tapcarta-standard");
    }

    if (normalizedFile.startsWith("resto/")) {
      applications.add("tapcarta-resto");
    }
  }

  return [...applications].sort();
}

function detectPublicApplications(changedFiles: string[]): string[] {
  const applications = new Set<string>();

  for (const file of changedFiles) {
    const normalizedFile = file.toLowerCase();

    if (isRepositoryMetadataOnly(normalizedFile)) {
      continue;
    }

    if (SHARED_DEPLOYMENT_FILES.has(normalizedFile)) {
      applications.add("tapcarta-site");
      applications.add("tapcarta-restaurants");
      continue;
    }

    if (normalizedFile.startsWith("restaurants/")) {
      applications.add("tapcarta-restaurants");
      continue;
    }

    applications.add("tapcarta-site");
  }

  return [...applications].sort();
}

function detectAdminApplications(changedFiles: string[]): string[] {
  const hasAdminRuntimeChange = changedFiles.some((file) => {
    const normalizedFile = file.toLowerCase();

    return !isRepositoryMetadataOnly(normalizedFile);
  });

  return hasAdminRuntimeChange ? ["tapcarta-admin"] : [];
}

function detectAffectedApplications(
  repository: string,
  changedFiles: string[],
): string[] | null {
  switch (repository.toLowerCase()) {
    case MASTER_REPOSITORY:
      return detectMasterApplications(changedFiles);

    case PUBLIC_REPOSITORY:
      return detectPublicApplications(changedFiles);

    case ADMIN_REPOSITORY:
      return detectAdminApplications(changedFiles);

    default:
      return null;
  }
}

function databaseHeaders(serviceRoleKey: string): HeadersInit {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };
}

async function findReleaseForCommit(
  supabaseUrl: string,
  serviceRoleKey: string,
  appKey: string,
  commitSha: string,
): Promise<ExistingRelease | null> {
  const url = new URL(
    `${supabaseUrl}/rest/v1/app_release_versions`,
  );

  url.searchParams.set(
    "select",
    "id,app_key,version,release_commit_sha,release_status,created_at",
  );
  url.searchParams.set("app_key", `eq.${appKey}`);
  url.searchParams.set("release_commit_sha", `eq.${commitSha}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: databaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(
      `Recherche du SHA impossible pour ${appKey}: ` +
        `${response.status} ${await response.text()}`,
    );
  }

  const rows = await response.json() as ExistingRelease[];
  return rows[0] ?? null;
}

async function getHumanDisplayVersion(
  supabaseUrl: string,
  serviceRoleKey: string,
  appKey: string,
): Promise<string> {
  const url = new URL(
    `${supabaseUrl}/rest/v1/app_release_versions`,
  );

  url.searchParams.set("select", "version");
  url.searchParams.set("app_key", `eq.${appKey}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: databaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(
      `Lecture de la version visuelle impossible pour ${appKey}: ` +
        `${response.status} ${await response.text()}`,
    );
  }

  const rows = await response.json() as Array<{ version?: string }>;
  const version = String(rows[0]?.version ?? "").trim();

  return version || "V0.0.0.0";
}

async function createRelease(
  supabaseUrl: string,
  serviceRoleKey: string,
  appKey: string,
  commitSha: string,
  repository: string,
  ref: string,
  changedFiles: string[],
  deliveryId: string | null,
): Promise<CreatedRelease> {
  const version = await getHumanDisplayVersion(
    supabaseUrl,
    serviceRoleKey,
    appKey,
  );

  const stabilizationStartedAt = new Date();
  const stabilizationEndsAt = new Date(
    stabilizationStartedAt.getTime() +
      STABILIZATION_MINUTES * 60 * 1000,
  );

  const response = await fetch(
    `${supabaseUrl}/rest/v1/app_release_versions`,
    {
      method: "POST",
      headers: {
        ...databaseHeaders(serviceRoleKey),
        prefer: "return=representation",
      },
      body: JSON.stringify({
        app_key: appKey,
        version,
        release_commit_sha: commitSha,
        release_status: "stabilizing",
        stabilization_minutes: STABILIZATION_MINUTES,
        stabilization_started_at:
          stabilizationStartedAt.toISOString(),
        stabilization_ends_at:
          stabilizationEndsAt.toISOString(),
        stabilization_completed_at: null,
        published_at: null,
        decision_at: null,
        decision_reason: null,
        vercel_deployment_id: null,
        vercel_deployment_url: null,
        release_notes: {
          source: "github_push_webhook",
          repository,
          ref,
          github_delivery_id: deliveryId,
          changed_files: changedFiles,
          human_version_policy:
            "display_only_copied_from_latest_known_release",
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Création impossible pour ${appKey}: ` +
        `${response.status} ${await response.text()}`,
    );
  }

  const rows = await response.json() as CreatedRelease[];

  if (!rows[0]) {
    throw new Error(
      `Supabase n'a retourné aucune publication pour ${appKey}.`,
    );
  }

  return rows[0];
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "method_not_allowed",
    });
  }

  const webhookSecret = Deno.env.get("GITHUB_WEBHOOK_SECRET");

  if (!webhookSecret) {
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
    webhookSecret,
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

  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return jsonResponse(400, {
      ok: false,
      error: "invalid_commit_sha",
    });
  }

  const changedFiles = collectChangedFiles(payload);
  const affectedApplications = detectAffectedApplications(
    repository,
    changedFiles,
  );

  if (affectedApplications === null) {
    return jsonResponse(202, {
      ok: true,
      ignored: true,
      reason: "repository_not_enabled",
      repository,
      commit_sha: commitSha,
    });
  }

  if (affectedApplications.length === 0) {
    return jsonResponse(200, {
      ok: true,
      ignored: true,
      reason: "no_application_path_affected",
      repository,
      commit_sha: commitSha,
      changed_files: changedFiles,
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.",
    );

    return jsonResponse(500, {
      ok: false,
      error: "database_configuration_error",
    });
  }

  const createdReleases: CreatedRelease[] = [];
  const existingReleases: ExistingRelease[] = [];

  try {
    for (const appKey of affectedApplications) {
      const existing = await findReleaseForCommit(
        supabaseUrl,
        serviceRoleKey,
        appKey,
        commitSha,
      );

      if (existing) {
        existingReleases.push(existing);
        continue;
      }

      const created = await createRelease(
        supabaseUrl,
        serviceRoleKey,
        appKey,
        commitSha,
        repository,
        payload.ref,
        changedFiles,
        req.headers.get("x-github-delivery"),
      );

      createdReleases.push(created);
    }
  } catch (error) {
    console.error("github-release-webhook failed.", error);

    return jsonResponse(500, {
      ok: false,
      error: "release_creation_failed",
      details:
        error instanceof Error ? error.message : String(error),
    });
  }

  return jsonResponse(
    createdReleases.length > 0 ? 201 : 200,
    {
      ok: true,
      dry_run: false,
      repository,
      ref: payload.ref,
      commit_sha: commitSha,
      changed_files: changedFiles,
      affected_applications: affectedApplications,
      created_releases: createdReleases,
      existing_releases: existingReleases,
      vercel_triggered: false,
      message:
        createdReleases.length > 0
          ? "UUID créé et délai de stabilisation démarré. Aucun appel Vercel."
          : "Livraison déjà traitée. Aucun doublon créé.",
    },
  );
});
