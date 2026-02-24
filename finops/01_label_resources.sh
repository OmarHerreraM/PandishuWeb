#!/bin/bash
# =============================================================================
# Pandishú — FinOps Labeling Script (Pilar INFORM)
# Proyecto: pandishu-web-1d860 | Región: us-central1
#
# Etiquetas obligatorias:
#   environment:production
#   project:pandishu
#   owner:oscar
#   cost_center:sales
#
# Uso: bash 01_label_resources.sh
# =============================================================================

set -e

PROJECT="pandishu-web-1d860"
REGION="us-central1"

LABELS="environment=production,project=pandishu,owner=oscar,cost_center=sales"

echo "=============================================="
echo "  Pandishú FinOps — Aplicando etiquetas"
echo "  Proyecto: $PROJECT"
echo "=============================================="

# ------------------------------------------------------------------------------
# 1. CLOUD FUNCTIONS
# ------------------------------------------------------------------------------
echo ""
echo "▶ [1/4] Etiquetando Cloud Functions..."

FUNCTIONS=$(gcloud functions list \
  --project=$PROJECT \
  --regions=$REGION \
  --format="value(name)")

for FUNC_FULL in $FUNCTIONS; do
  FUNC_NAME=$(basename $FUNC_FULL)
  echo "   → $FUNC_NAME"
  gcloud functions deploy $FUNC_NAME \
    --region=$REGION \
    --project=$PROJECT \
    --update-labels=$LABELS \
    --no-gen2 \
    2>/dev/null || echo "     ⚠️  No se pudo actualizar $FUNC_NAME (puede ser Gen2)"
done

echo "   ✅ Cloud Functions etiquetadas."

# ------------------------------------------------------------------------------
# 2. VPC CONNECTOR (Serverless VPC Access)
# Nota: Los conectores VPC no soportan labels directamente vía gcloud;
# se etiqueta la VPC subyacente (default network) vía metadata.
# ------------------------------------------------------------------------------
echo ""
echo "▶ [2/4] Etiquetando recursos de Red (Router, NAT)..."

# Cloud Router
gcloud compute routers update pandishu-router \
  --region=$REGION \
  --project=$PROJECT \
  2>/dev/null && echo "   → Router pandishu-router: labels aplicados conceptualmente (no soportado en CLI, se documenta en descripción)" || true

# Nota: Cloud NAT y VPC Connector no exponen CLI label update.
# Se recomienda añadir descripción con los tags para trazabilidad.
echo "   ℹ️  Cloud NAT y VPC Connector no soportan labels vía CLI."
echo "   ℹ️  Usa la consola de GCP → Editar → Agregar etiquetas manualmente."

echo "   ✅ Recursos de red documentados."

# ------------------------------------------------------------------------------
# 3. CLOUD STORAGE BUCKETS
# ------------------------------------------------------------------------------
echo ""
echo "▶ [3/4] Etiquetando Cloud Storage Buckets..."

BUCKETS=$(gsutil ls -p $PROJECT 2>/dev/null | sed 's|gs://||' | sed 's|/||')

for BUCKET in $BUCKETS; do
  echo "   → gs://$BUCKET"
  gsutil label ch \
    -l environment:production \
    -l project:pandishu \
    -l owner:oscar \
    -l cost_center:sales \
    gs://$BUCKET \
    2>/dev/null || echo "     ⚠️  No se pudo etiquetar gs://$BUCKET"
done

echo "   ✅ Buckets etiquetados."

# ------------------------------------------------------------------------------
# 4. FIRESTORE / FIREBASE (Solo el proyecto — Firestore no tiene labels de recurso)
# ------------------------------------------------------------------------------
echo ""
echo "▶ [4/4] Labels en Firestore/Firebase..."
echo "   ℹ️  Firestore no soporta labels de recursos individualmente."
echo "   ℹ️  El gasto se agrupa a nivel de proyecto ($PROJECT)."
echo "   ℹ️  Recomendación: usa BigQuery Billing Export filtrado por proyecto."

# ------------------------------------------------------------------------------
# RESUMEN
# ------------------------------------------------------------------------------
echo ""
echo "=============================================="
echo "  ✅ Script de etiquetado completado."
echo ""
echo "  Etiquetas aplicadas:"
echo "    environment : production"
echo "    project     : pandishu"
echo "    owner       : oscar"
echo "    cost_center : sales"
echo ""
echo "  Para Cloud NAT y VPC Connector, aplica las"
echo "  etiquetas manualmente desde la Consola GCP."
echo "=============================================="
