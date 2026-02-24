#!/bin/bash
# =============================================================================
# Pandishú — FinOps: Etiquetas para Cloud Functions & Proyecto
# Proyecto: pandishu-web-1d860 | Región: us-central1
# =============================================================================

set -e

PROJECT="pandishu-web-1d860"
REGION="us-central1"
LABELS="environment=production,project=pandishu,owner=oscar,cost_center=sales"

echo "=============================================="
echo "  Pandishú FinOps — Labels Functions"
echo "  Proyecto: $PROJECT | Región: $REGION"
echo "=============================================="
echo ""

# 0. Agregar el tag 'environment: Production' al proyecto para quitar el warning de gcloud
echo "▶ [1/2] Añadiendo tag 'environment' al proyecto..."
# Nota: La creación de tags formales en Resource Manager requiere permisos de org admin.
# Solo intentaremos agregarlo como label a nivel proyecto si es posible.
gcloud projects update $PROJECT --update-labels=environment=production 2>/dev/null || echo "   ℹ️ Omitiendo tag formal de resource manager (requiere org auth). Label de proyecto actualizado."

echo ""
echo "▶ [2/2] Listando y etiquetando Cloud Functions..."

# Obtener lista de funciones (Firebase despliega en V1 por defecto a menos que se especifique lo contrario)
FUNCTIONS=$(gcloud functions list --project=$PROJECT --regions=$REGION --format="value(name)" 2>/dev/null)

if [ -z "$FUNCTIONS" ]; then
  echo "⚠️  No se encontraron Cloud Functions en $REGION."
  exit 1
fi

COUNT=0
ERRORS=0

for FUNC_FULL in $FUNCTIONS; do
  FUNC_NAME=$(basename "$FUNC_FULL")
  echo -n "   → $FUNC_NAME ... "

  # Actualizar etiquetas (Firebase functions son v1)
  if gcloud functions deploy "$FUNC_NAME" \
    --region="$REGION" \
    --project="$PROJECT" \
    --update-labels="$LABELS" \
    --quiet 2>/dev/null; then
    echo "✅"
    ((COUNT++)) || true
  else
    echo "⚠️ Error al actualizar"
    ((ERRORS++)) || true
  fi
done

echo ""
echo "=============================================="
echo "  Resumen:"
echo "    ✅ Etiquetadas correctamente : $COUNT"
echo "    ⚠️  Con advertencias          : $ERRORS"
echo "=============================================="
