import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ContractRow = {
  id: string;
  restaurant_id: string | null;
  join_request_id: string | null;
  contract_number: string;
  contract_version: string | null;
  language_displayed: string | null;
  official_language: string | null;
  status: string | null;
  signed_at: string | null;
  signed_email: string | null;
  pdf_storage_path: string | null;
  pdf_generated_at: string | null;
  pdf_sent_at: string | null;
  planned_commercial_activation_date: string | null;
  pack_code: string | null;
  monthly_price: number | string | null;
  currency: string | null;
  signer_name: string | null;
  company_name: string | null;
  signer_role: string | null;
  signature_language: string | null;
  payment_status: string | null;
  payment_provider: string | null;
  signature_source: string | null;
  activation_mode: string | null;
  metadata: Record<string, unknown> | null;
  terms_snapshot: Record<string, unknown> | null;
  commercial_snapshot: Record<string, unknown> | null;
  contract_type: string | null;
  pdf_status: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function safeString(value: unknown, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function formatDateES(value: string | null | undefined, fallback = "Pendiente") {
  if (!value) return fallback;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());

  return `${day}/${month}/${year}`;
}

function buildOutputName(contract: ContractRow) {
  const metadata = contract.metadata || {};
  const restaurantName =
    safeString(metadata.restaurant_trade_name) ||
    safeString(metadata.restaurant_name) ||
    "restaurant";

  const safeRestaurant = restaurantName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 48) || "restaurant";

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");

  return `${contract.contract_number}_${safeRestaurant}_ES_oficial_${yyyy}-${mm}-${dd}`;
}

function buildStoragePath(outputName: string) {
  return `${outputName}.pdf`;
}

function getInitialTermMonths(contract: ContractRow) {
  return safeString(contract.terms_snapshot?.initial_term_months, "12");
}

function getPaymentMethod(contract: ContractRow) {
  return (
    safeString(contract.commercial_snapshot?.payment_method) ||
    "Domiciliación SEPA / GoCardless"
  );
}

function getSelectedOfferLabel(contract: ContractRow) {
  return (
    safeString(contract.commercial_snapshot?.selected_offer_label) ||
    safeString(contract.pack_code).toUpperCase()
  );
}

function getMonthlyPrice(contract: ContractRow) {
  const priceFromSnapshot = contract.commercial_snapshot?.monthly_price_htva;
  const price = safeString(priceFromSnapshot || contract.monthly_price);

  if (!price) return "Pendiente";
  return price;
}

function buildContractData(contract: ContractRow) {
  const metadata = contract.metadata || {};
  const today = formatDateES(new Date().toISOString());

  return {
    contract_reference: safeString(contract.contract_number),
    document_date: today,

    client_legal_name:
      safeString(contract.company_name) ||
      safeString(metadata.client_legal_name) ||
      "Pendiente",

    restaurant_trade_name:
      safeString(metadata.restaurant_trade_name) ||
      safeString(metadata.restaurant_name) ||
      "Pendiente",

    client_tax_id:
      safeString(metadata.client_tax_id) ||
      safeString(metadata.tax_number) ||
      "Pendiente",

    billing_email:
      safeString(metadata.billing_email) ||
      safeString(contract.signed_email) ||
      "Pendiente",

    signer_name:
      safeString(contract.signer_name) ||
      safeString(metadata.signer_name) ||
      "Pendiente",

    signer_role:
      safeString(contract.signer_role) ||
      safeString(metadata.signer_role) ||
      "Representante autorizada",

    selected_offer: getSelectedOfferLabel(contract),

    monthly_price_htva: getMonthlyPrice(contract),

    commercial_activation_date: formatDateES(
      contract.planned_commercial_activation_date ||
        safeString(contract.commercial_snapshot?.planned_commercial_activation_date),
      "Pendiente"
    ),

    initial_term_months: getInitialTermMonths(contract),

    payment_method: getPaymentMethod(contract),

    signature_date: contract.signed_at
      ? formatDateES(contract.signed_at)
      : "Pendiente de firma",

    signature_placeholder: contract.signed_at
      ? "Aceptación electrónica confirmada por el cliente."
      : "Firma electrónica pendiente",

    digital_signature_audit_trail: contract.signed_at
      ? "El cliente ha confirmado haber recibido, leído y aceptado el contrato TapCarta. La aceptación electrónica queda registrada en el sistema TapCarta."
      : "La aceptación electrónica, junto con la fecha, hora, dirección IP y datos técnicos disponibles, se conservará como prueba de aceptación del contrato.",
  };
}

async function downloadPdf(documentUri: string) {
  const response = await fetch(documentUri);

  if (!response.ok) {
    throw new Error(`Impossible de télécharger le PDF généré DocuGenerate. HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();

  if (!arrayBuffer.byteLength) {
    throw new Error("Le PDF généré par DocuGenerate est vide.");
  }

  return arrayBuffer;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Méthode non autorisée" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const docuGenerateApiKey = Deno.env.get("DOCUGENERATE_API_KEY");
  const docuGenerateTemplateEsId = Deno.env.get("DOCUGENERATE_TEMPLATE_ES_ID");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({
      success: false,
      error: "Secrets Supabase manquants : SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY",
    }, 500);
  }

  if (!docuGenerateApiKey || !docuGenerateTemplateEsId) {
    return jsonResponse({
      success: false,
      error: "Secrets DocuGenerate manquants : DOCUGENERATE_API_KEY ou DOCUGENERATE_TEMPLATE_ES_ID",
    }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  let body: { contractId?: string; contractNumber?: string };

  try {
    body = await req.json();
  } catch (_error) {
    return jsonResponse({
      success: false,
      error: "Body JSON invalide",
    }, 400);
  }

  const contractId = safeString(body.contractId);
  const contractNumber = safeString(body.contractNumber);

  if (!contractId && !contractNumber) {
    return jsonResponse({
      success: false,
      error: "contractId ou contractNumber obligatoire",
    }, 400);
  }

  try {
    let query = supabaseAdmin
      .from("contracts")
      .select("*")
      .limit(1)
      .single();

    if (contractId) {
      query = supabaseAdmin
        .from("contracts")
        .select("*")
        .eq("id", contractId)
        .limit(1)
        .single();
    } else {
      query = supabaseAdmin
        .from("contracts")
        .select("*")
        .eq("contract_number", contractNumber)
        .limit(1)
        .single();
    }

    const { data: contract, error: contractError } = await query;

    if (contractError || !contract) {
      return jsonResponse({
        success: false,
        error: "Contrat introuvable",
        details: contractError?.message || null,
      }, 404);
    }

    const typedContract = contract as ContractRow;

    await supabaseAdmin
      .from("contracts")
      .update({
        pdf_status: "generating",
        pdf_generation_method: "automatic",
        pdf_generation_provider: "docugenerate",
        pdf_generation_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", typedContract.id);

    const contractData = buildContractData(typedContract);

    /*
      IMPORTANT DocuGenerate:
      Le champ data doit être un tableau JSON, même pour un seul contrat.
      Ne pas envoyer directement contractData.
    */
    const docuGenerateData = [contractData];

    const outputName = buildOutputName(typedContract);
    const storagePath = buildStoragePath(outputName);

    const formData = new FormData();
    formData.append("template_id", docuGenerateTemplateEsId);
    formData.append("data", JSON.stringify(docuGenerateData));
    formData.append("output_format", ".pdf");
    formData.append("output_name", outputName);
    formData.append("single_file", "true");
    formData.append("page_break", "true");

    const docuResponse = await fetch("https://api.docugenerate.com/v1/document", {
      method: "POST",
      headers: {
        Authorization: docuGenerateApiKey,
        Accept: "application/json",
      },
      body: formData,
    });

    const docuText = await docuResponse.text();

    if (!docuResponse.ok) {
      await supabaseAdmin
        .from("contracts")
        .update({
          pdf_status: "failed",
          pdf_generation_error: docuText,
          updated_at: new Date().toISOString(),
        })
        .eq("id", typedContract.id);

      return jsonResponse({
        success: false,
        error: "Erreur DocuGenerate",
        status: docuResponse.status,
        details: docuText,
      }, 502);
    }

    let docuJson: {
      document_uri?: string;
      filename?: string;
      id?: string;
      format?: string;
    };

    try {
      docuJson = JSON.parse(docuText);
    } catch (_error) {
      throw new Error(`Réponse DocuGenerate non JSON : ${docuText}`);
    }

    if (!docuJson.document_uri) {
      throw new Error(`DocuGenerate n'a pas retourné document_uri : ${docuText}`);
    }

    const pdfBuffer = await downloadPdf(docuJson.document_uri);

    const { error: uploadError } = await supabaseAdmin
      .storage
      .from("contract-pdfs")
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload Supabase Storage échoué : ${uploadError.message}`);
    }

    const { data: updatedContract, error: updateError } = await supabaseAdmin
      .from("contracts")
      .update({
        pdf_storage_path: storagePath,
        pdf_status: "generated",
        pdf_generation_method: "automatic",
        pdf_generation_provider: "docugenerate",
        pdf_generated_at: new Date().toISOString(),
        pdf_generation_error: null,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(typedContract.metadata || {}),
          last_docugenerate_document_id: docuJson.id || null,
          last_docugenerate_filename: docuJson.filename || null,
          last_docugenerate_format: docuJson.format || null,
          last_pdf_generated_automatically: true,
        },
      })
      .eq("id", typedContract.id)
      .select("id, contract_number, pdf_status, pdf_storage_path, pdf_generated_at")
      .single();

    if (updateError) {
      throw new Error(`Mise à jour contracts échouée : ${updateError.message}`);
    }

    return jsonResponse({
      success: true,
      message: "PDF contrat généré automatiquement",
      contract: updatedContract,
      storagePath,
      docugenerate: {
        id: docuJson.id || null,
        filename: docuJson.filename || null,
        format: docuJson.format || null,
      },
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    const contractRef = contractId || contractNumber;

    if (contractRef) {
      const updateQuery = contractId
        ? supabaseAdmin.from("contracts").update({
            pdf_status: "failed",
            pdf_generation_error: message,
            updated_at: new Date().toISOString(),
          }).eq("id", contractId)
        : supabaseAdmin.from("contracts").update({
            pdf_status: "failed",
            pdf_generation_error: message,
            updated_at: new Date().toISOString(),
          }).eq("contract_number", contractNumber);

      await updateQuery;
    }

    return jsonResponse({
      success: false,
      error: message,
    }, 500);
  }
});
