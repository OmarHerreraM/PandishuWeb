#!/bin/bash
# =============================================================================
# Pandishú FinOps — Alerta de Presupuesto
# Proyecto: pandishu-web-1d860
# Monto: $25 USD/mes | Alertas: 50%, 80%, 100%
#
# NOTA IMPORTANTE:
# La API de gcloud billing budgets requiere el ID de la cuenta de facturación.
# Ejecútalo en Cloud Shell con tu sesión activa.
# =============================================================================

# PASO 1: Obtener el ID de tu cuenta de facturación (ejecuta esto primero)
echo "=== Tu cuenta de facturación ==="
gcloud billing accounts list --format="table(name, displayName, open)"

echo ""
echo "Copia el ID de la cuenta (formato: XXXXXX-XXXXXX-XXXXXX)"
echo "Luego ajusta la variable BILLING_ACCOUNT abajo y ejecuta el PASO 2."

# ==============================================================================
# PASO 2: Crea el presupuesto (edita BILLING_ACCOUNT con el ID del paso anterior)
# ==============================================================================

# ⚠️ EDITA ESTE VALOR con tu Billing Account ID real (del paso anterior)
BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"
PROJECT="pandishu-web-1d860"

gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="pandishu-monthly-budget" \
  --budget-amount=25USD \
  --threshold-rules=basis=CURRENT_SPEND,percent=50 \
  --threshold-rules=basis=CURRENT_SPEND,percent=80 \
  --threshold-rules=basis=CURRENT_SPEND,percent=100 \
  --filter-projects="projects/$PROJECT" \
  --all-updates-rule-monitoring-notification-channels="" \
  --format="json"

echo ""
echo "=============================================="
echo "  ✅ Presupuesto creado:"
echo "    Monto    : \$25 USD/mes"
echo "    Alertas  : 50% → \$12.50 | 80% → \$20 | 100% → \$25"
echo ""
echo "  Para recibir el email a pandipandishu@gmail.com,"
echo "  ve a la consola y aggrega el canal de notificación:"
echo "  Facturación → Presupuestos → pandishu-monthly-budget → Editar"
echo "=============================================="

# ==============================================================================
# ALTERNATIVA MANUAL (más fácil, sin necesidad del Billing Account ID)
# ==============================================================================

echo ""
echo "--- ALTERNATIVA: Consola Web ---"
echo "Si el comando falla, ve directamente a:"
echo "https://console.cloud.google.com/billing/budgets"
echo ""
echo "  1. Haz clic en 'Crear Presupuesto'."
echo "  2. Nombre: pandishu-monthly-budget"
echo "  3. Alcance: Proyecto pandishu-web-1d860"
echo "  4. Monto: \$25 USD"
echo "  5. Alertas: 50%, 80%, 100% (Costo actual)"
echo "  6. Notificaciones: Agrega tu email en 'Canales de alertas'."
echo "  7. Guarda."
