#!/bin/bash
# =============================================================================
# Pandishú — Rightsizing: Timeout 60s para todas las Cloud Functions
# Proyecto: pandishu-web-1d860 | Región: us-central1
#
# 540s (default) es peligroso: si una llamada a CT se cuelga,
# pagas 9 minutos de CPU por nada. 60s es más que suficiente.
#
# Uso: bash 05_set_timeouts.sh
# =============================================================================

set -e

PROJECT="pandishu-web-1d860"
REGION="us-central1"
TIMEOUT="60s"

# Funciones críticas del backend de Pandishú
FUNCTIONS=(
  "searchProducts"
  "getPriceAndAvailability"
  "createCheckoutSession"
  "processCustomPayment"
  "mpWebhook"
  "getInvoiceDetails"
  "searchInvoices"
  "createOrderV7"
  "getOrderDetails"
  "searchOrders"
  "cancelOrder"
  "modifyOrder"
  "getVendorRequiredInfo"
  "testIpPandishu"
)

echo "=============================================="
echo "  Pandishú FinOps — Rightsizing de Timeouts"
echo "  Nuevo timeout: $TIMEOUT"
echo "  Proyecto: $PROJECT"
echo "=============================================="
echo ""

COUNT=0
ERRORS=0

for FUNC in "${FUNCTIONS[@]}"; do
  echo -n "   → $FUNC ... "

  # Intentar actualizar timeout vía Cloud Run (Gen2)
  if gcloud run services update "$FUNC" \
    --region="$REGION" \
    --project="$PROJECT" \
    --timeout="$TIMEOUT" \
    --quiet 2>/dev/null; then
    echo "✅ 60s (Cloud Run)"
    ((COUNT++)) || true

  # Fallback Gen1
  elif gcloud functions deploy "$FUNC" \
    --region="$REGION" \
    --project="$PROJECT" \
    --timeout="$TIMEOUT" \
    --no-gen2 \
    --quiet 2>/dev/null; then
    echo "✅ 60s (Gen1)"
    ((COUNT++)) || true

  else
    echo "⚠️ Sin cambios (puede requerir redeploy completo)"
    ((ERRORS++)) || true
  fi

done

echo ""
echo "=============================================="
echo "  Resumen Rightsizing:"
echo "    ✅ Actualizadas : $COUNT"
echo "    ⚠️  Sin cambios  : $ERRORS"
echo ""
echo "  Ahorro estimado: ~\$2-5 USD/mes por evitar"
echo "  ejecuciones colgadas de 9 minutos."
echo "=============================================="
