import { createClient } from "npm:@supabase/supabase-js@2";

declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: {
    get: (key: string) => string | undefined;
  };
};

type ReleaseRecord = {
  id: string;
  app_key: string;
  version: string;
  release_commit_sha: string | null;
  release_status: string;
  stabilization_started_at: string | null;
  stabilization_ends_at: string | null;
  published_at: string | null;
  vercel_deployment_id: string | null;
  vercel_deployment_url: string | null;
  created_at: string;
};

type VercelDeployment = {
  uid?: string;
  id?: string;
  url?: string | null;
  readyState?: string;
  state?: string;
  target?: string | null;
};

const ACTIVE_RELEASE_STATUSES = new Set([
  "candidate",
  "stabilizing",
  "ready_for_deployment",
]);

const APP_PROJECT_MAP: Record<string, string> = {
  "tapcarta-standard": "VERCEL_PROJECT_ID_MASTER",
  "tapcarta-resto": "VERCEL_PROJECT_ID_MASTER",
  "tapcarta-site": "VERCEL_PROJECT_ID_PUBLIC",
  "tapcarta-restaurants": "VERCEL_PROJECT_ID_PUBLIC",
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

function getRequiredSecret(name: string): string {
  const value = String(Deno.env.get(name) ?? "").trim();

  if (!value) {
    throw new Error(`Secret absent : ${name}`);
  }

  return value;
}

function getBearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());

  return match?.[1] ?? null;
}

function getVercelProjectId(appKey: string): string {
  const secretName = APP_PROJECT_MAP[appKey];

  if (!secretName) {
    throw new Error(`Application non prise en charge : ${appKey}`);
  }

  return getRequiredSecret(secretName);
}

async function findVercelDeployment(
  token: string,
  teamId: string,
  projectId: string,
  commitSha: string,
): Promise<VercelDeployment> {
  const url = new URL("https://api.vercel.com/v7/deployments");

  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sha", commitSha);
  url.searchParams.set("teamId", teamId);
  url.searchParams.set("limit", "20");

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Recherche Vercel impossible : ${response.status} ${responseText}`,
    );
  }

  const payload = JSON.parse(responseText) as {
    deployments?: VercelDeployment[];
  };

  const deployments = payload.deployments ?? [];

  const readyDeployment = deployments.find((deployment) => {
    const state = deployment.readyState ?? deployment.state;
    return state === "READY" && Boolean(deployment.uid ?? deployment.id);
  });

  if (!readyDeployment) {
    throw new Error(
      `Aucun déploiement Vercel READY trouvé pour le SHA ${commitSha}.`,
    );
  }

  return readyDeployment;
}

async function promoteDeployment(
  token: string,
  teamId: string,
  projectId: string,
  deploymentId: string,
): Promise<"promote" | "rollback"> {
  const promoteUrl = new URL(
    `https://api.vercel.com/v10/projects/${projectId}/promote/${deploymentId}`,
  );
  promoteUrl.searchParams.set("teamId", teamId);

  const promoteResponse = await fetch(promoteUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });

  if (promoteResponse.status === 201 || promoteResponse.status === 202) {
    return "promote";
  }

  const promoteError = await promoteResponse.text();

  if (promoteResponse.status !== 409) {
    throw new Error(
      `Promotion Vercel impossible : ` +
        `${promoteResponse.status} ${promoteError}`,
    );
  }

  const rollbackUrl = new URL(
    `https://api.vercel.com/v1/projects/${projectId}/rollback/${deploymentId}`,
  );
  rollbackUrl.searchParams.set("teamId", teamId);
  rollbackUrl.searchParams.set(
    "description",
    "TapCarta manual release publication",
  );

  const rollbackResponse = await fetch(rollbackUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });

  const rollbackText = await rollbackResponse.text();

  if (rollbackResponse.status !== 201) {
    throw new Error(
      `Rollback Vercel impossible : ` +
        `${rollbackResponse.status} ${rollbackText}`,
    );
  }

  return "rollback";
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "authorization, apikey, content-type, x-client-info",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "method_not_allowed",
    });
  }

  try {
    const supabaseUrl = getRequiredSecret("SUPABASE_URL");
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!anonKey) {
      throw new Error(
        "SUPABASE_ANON_KEY ou SUPABASE_PUBLISHABLE_KEY absent.",
      );
    }

    const serviceRoleKey =
      getRequiredSecret("SUPABASE_SERVICE_ROLE_KEY");
    const publisherUid =
      getRequiredSecret("TAPCARTA_RELEASE_PUBLISHER_UID");

    const bearerToken = getBearerToken(req);

    if (!bearerToken) {
      return jsonResponse(401, {
        ok: false,
        error: "missing_authorization",
      });
    }

    const authClient = createClient(supabaseUrl, anonKey);
    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser(bearerToken);

    if (userError || !user) {
      return jsonResponse(401, {
        ok: false,
        error: "invalid_user",
      });
    }

    if (user.id !== publisherUid) {
      return jsonResponse(403, {
        ok: false,
        error: "publisher_not_authorized",
      });
    }

    let body: { release_id?: unknown };

    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: "invalid_json",
      });
    }

    const releaseId = String(body.release_id ?? "").trim();

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(releaseId)
    ) {
      return jsonResponse(400, {
        ok: false,
        error: "invalid_release_id",
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: release, error: releaseError } = await admin
      .from("app_release_versions")
      .select(
        "id,app_key,version,release_commit_sha,release_status," +
          "stabilization_started_at,stabilization_ends_at,published_at," +
          "vercel_deployment_id,vercel_deployment_url,created_at",
      )
      .eq("id", releaseId)
      .single();

    if (releaseError || !release) {
      return jsonResponse(404, {
        ok: false,
        error: "release_not_found",
      });
    }

    const typedRelease = release as ReleaseRecord;

    if (!ACTIVE_RELEASE_STATUSES.has(typedRelease.release_status)) {
      return jsonResponse(409, {
        ok: false,
        error: "release_not_publishable",
        release_status: typedRelease.release_status,
      });
    }

    const commitSha =
      String(typedRelease.release_commit_sha ?? "").trim();

    if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
      return jsonResponse(409, {
        ok: false,
        error: "release_has_no_valid_commit_sha",
      });
    }

    const projectId = getVercelProjectId(typedRelease.app_key);
    const vercelToken = getRequiredSecret("VERCEL_API_TOKEN");
    const teamId = getRequiredSecret("VERCEL_TEAM_ID");

    const deployment = await findVercelDeployment(
      vercelToken,
      teamId,
      projectId,
      commitSha,
    );

    const deploymentId = String(
      deployment.uid ?? deployment.id ?? "",
    );
    const deploymentUrl = deployment.url
      ? `https://${deployment.url}`
      : null;

    const operation = await promoteDeployment(
      vercelToken,
      teamId,
      projectId,
      deploymentId,
    );

    const now = new Date().toISOString();

    const { data: updatedRelease, error: updateError } = await admin
      .from("app_release_versions")
      .update({
        release_status: "published",
        published_at: now,
        stabilization_completed_at: now,
        decision_at: now,
        decision_reason:
          operation === "rollback"
            ? "manual_immediate_rollback"
            : "manual_immediate_publish",
        vercel_deployment_id: deploymentId,
        vercel_deployment_url: deploymentUrl,
      })
      .eq("id", releaseId)
      .select()
      .single();

    if (updateError) {
      console.error(
        "Vercel a été modifié mais Supabase n'a pas été mis à jour.",
        updateError,
      );

      return jsonResponse(500, {
        ok: false,
        error: "database_update_failed_after_vercel_success",
        vercel_operation: operation,
        deployment_id: deploymentId,
      });
    }

    return jsonResponse(200, {
      ok: true,
      action: "publish_immediately",
      vercel_operation: operation,
      release: updatedRelease,
    });
  } catch (error) {
    console.error("publish-release failed.", error);

    return jsonResponse(500, {
      ok: false,
      error: "publish_release_failed",
      details:
        error instanceof Error ? error.message : String(error),
    });
  }
});
