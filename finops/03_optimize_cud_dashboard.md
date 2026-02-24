# Pandishú — Análisis CUD y Dashboard Looker Studio (Pilar OPTIMIZE)
# proyecto: pandishu-web-1d860
# fecha: Febrero 2026

## 1. ¿Qué son los CUDs y cuándo aplican?

Los Committed Use Discounts (CUDs) son acuerdos donde te comprometes a usar un nivel mínimo de recursos de
GCP por 1 o 3 años, y a cambio Google te otorga hasta un 57% de descuento sobre el precio on-demand.

### Tipos de CUD:

| Tipo                 | Qué cubre                    | Descuento típico | Flexibilidad          |
|----------------------|------------------------------|------------------|-----------------------|
| **Instance CUD**     | Una vCPU + RAM específica     | Hasta 57%        | Baja — atado a familia|
| **Flexible CUD**     | vCPU + RAM en cualquier VM    | Hasta 28%        | Alta — cualquier tipo |

---

## 2. Análisis de tu arquitectura actual

Pandishú utiliza **Cloud Functions (1st Gen)** que son **serverless**: solo incurren en costo cuando se invocan.
No hay VMs permanentes como Cloud Run con `minInstances=1` o Compute Engine corriendo 24/7.

| Recurso                  | Tipo         | Siempre activo | Candidato a CUD |
|--------------------------|--------------|----------------|-----------------|
| Cloud Functions (13)     | Serverless   | ❌ No           | ❌ No           |
| VPC Connector            | Managed      | ✅ Sí (mínimo)  | ⚠️ Marginal     |
| Cloud NAT                | Managed      | ✅ Sí           | ❌ No (flat fee) |
| Cloud Storage            | Object store | ✅ Sí           | ❌ No           |
| Firebase Hosting         | CDN managed  | ✅ Sí           | ❌ No           |

### 📊 Conclusión del análisis:

> **En el estado actual del proyecto, NO se recomienda adquirir un CUD de 1 año.**

**Razones:**
1. Pandishú no tiene **recursos de cómputo persistentes** (VMs). Un CUD es esencialmente para Compute Engine o CloudRun con mínimos fijos.
2. El costo dominante es **Cloud NAT** (~$0.045 USD/hora fijos) + **VPC Connector** (~$0.12 USD/hora a instancias mínimas). Estos **no califican para CUD**.
3. Una sola Cloud Function no factura por "tiempo de CPU base"; solo al ser invocada.

---

## 3. ¿Cuándo SERÍA momento de comprar un CUD?

Si en el futuro Pandishú escala a alguno de estos escenarios:

- Migras el backend a Cloud Run con `--min-instances=1` o superior (siempre activo).
- Instalas un servidor de base de datos en una VM de Compute Engine.
- Usas Cloud SQL u otro servicio gestionado con instancias dedicadas.

En ese momento: **compra un Flexible CUD** (28% de descuento) porque tienes microservicios donde el tipo de máquina puede cambiar. Evita el Instance CUD a menos que tengas certeza total del tipo de VM.

---

## 4. Recomendación de ahorro inmediato (sin CUD)

Mientras el tráfico es bajo, estos pasos son más efectivos que un CUD:

| Acción                              | Ahorro estimado | Esfuerzo |
|-------------------------------------|-----------------|----------|
| VPC Connector: bajar min instances a 2 (ya está en 2 — OK) | $0/mes     | Ninguno  |
| Cloud NAT: configurar `drain_nat_ips` si no hay tráfico | ~$5/mes | Bajo    |
| Cloud Functions: reducir timeout de 540s a 60s      | ~$2/mes    | Bajo     |
| Budget Alerts en Billing: alerta al 80% del presupuesto | $0 directo | Bajo  |

---

## 5. Pasos para configurar el Dashboard de Looker Studio

### A. Habilitar Billing Export (INDISPENSABLE antes que todo)

1. Ve a [Facturación de Google Cloud](https://console.cloud.google.com/billing).
2. En el menú lateral: **"Exportar presupuesto"** → **"BigQuery"**.
3. Selecciona tu cuenta de facturación.
4. En "Standard Usage Cost":
   - **Proyecto:** `pandishu-web-1d860`
   - **Dataset:** `billing_export` (créalo si no existe con el comando abajo)
5. Guarda. Los datos empezarán a llegar dentro de **24-48 horas**.

```bash
# Crear el dataset billing_export en BigQuery (regíon US recomendada por Google Billing)
bq --location=US mk \
  --dataset \
  --description "Export de facturación estándar de Google Cloud para Pandishú" \
  pandishu-web-1d860:billing_export
```

### B. Conectar Looker Studio al dataset

1. Ve a [Looker Studio](https://lookerstudio.google.com/) → **Crear** → **Reporte**.
2. Elige fuente de datos: **BigQuery**.
3. Selecciona:
   - Proyecto: `pandishu-web-1d860`
   - Dataset: `billing_export`
   - Tabla: `gcp_billing_export_v1_XXXXXX` (la que crea Google automáticamente)
4. Haz clic en **Conectar** y luego **Crear reporte**.

### C. Widgets recomendados para el Dashboard

```
┌──────────────────────────────────────────────────────┐
│        🏠 Pandishú FinOps Dashboard                   │
├────────────────┬────────────────┬────────────────────┤
│  Costo del Mes │  Costo Cloud   │  Invocaciones      │
│  (Tarjeta)     │  NAT / IP Fija │  Cloud Functions   │
├────────────────┴────────────────┴────────────────────┤
│       Gasto por servicio — Gráfica de barras          │
│  (Cloud Functions | Cloud NAT | Firebase | Storage)  │
├──────────────────────────────────────────────────────┤
│       Tendencia de costo — últimos 30 días            │
│       (Línea de tiempo diaria)                        │
├──────────────────────────────────────────────────────┤
│       Tabla: SKU detallado con filtro por label       │
│       (filtrar por cost_center=sales)                 │
└──────────────────────────────────────────────────────┘
```

### D. Campos clave de la tabla de BigQuery para Looker Studio

| Campo de BigQuery              | Métrica en Looker Studio     |
|-------------------------------|------------------------------|
| `cost`                        | Métrica principal (SUM)      |
| `service.description`         | Dimensión — Servicio         |
| `sku.description`             | Dimensión — SKU              |
| `usage_start_time`            | Dimensión — Fecha            |
| `labels.value` (cost_center)  | Filtro por etiqueta          |
| `project.id`                  | Filtro por proyecto          |

> 💡 **Pro tip:** Una vez que el Billing Export lleve 30 días activo, activa el "Cost insights" en el panel
> de facturación — Google empezará a mostrarte recomendaciones automáticas de rightsizig y anomalías.

---

## 6. Budget Alert — Evita sorpresas

Configura una alerta para que Google te avise si el gasto supera un umbral:

```bash
# Crea un presupuesto para pandishu-web-1d860 (ajusta el monto en USD)
# Este comando es informativo — la consola aún es la forma más sencilla
# Ir a: Facturación → Presupuestos y alertas → Crear presupuesto
#   - Nombre: pandishu-monthly-budget
#   - Monto: $30 USD/mes
#   - Alertas: 50%, 80%, 100%
#   - Notificación: tu email
echo "Ve a: https://console.cloud.google.com/billing/budgets para crear el presupuesto."
```

---

## 7. Resumen del impacto en FinOps Score

| Pilar      | Acción                          | Impacto en Score |
|------------|---------------------------------|-----------------|
| INFORM     | Labels en todos los recursos    | +0.5 pts        |
| INFORM     | Tags en Billing por proyecto    | +0.3 pts        |
| OPERATE    | Billing Export a BigQuery       | +0.5 pts        |
| OPERATE    | Dashboard en Looker Studio      | +0.4 pts        |
| OPERATE    | Budget Alerts configurados      | +0.3 pts        |
| OPTIMIZE   | Rightsizing de timeouts         | +0.2 pts        |
| OPTIMIZE   | Cloud NAT drain en bajos picos  | +0.1 pts        |
| **TOTAL**  |                                 | **≈ +2.3 pts → Score Final: ~5.3** |
