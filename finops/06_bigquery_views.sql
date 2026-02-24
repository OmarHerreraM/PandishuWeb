-- =============================================================================
-- Pandishú FinOps — BigQuery View para Looker Studio
-- Dataset: pandishu-web-1d860.billing_export
--
-- INSTRUCCIONES:
-- 1. Reemplaza TABLE_ID con el nombre real de tu tabla de billing.
--    Puedes encontrarlo con:
--    SELECT table_name FROM billing_export.INFORMATION_SCHEMA.TABLES
--    WHERE table_name LIKE 'gcp_billing_export%';
--
-- 2. Ejecuta este CREATE OR REPLACE VIEW en BigQuery.
-- 3. En Looker Studio, conecta a esta vista como fuente de datos.
-- =============================================================================

-- PASO 1: Crear la vista resumida por mes y etiqueta
CREATE OR REPLACE VIEW
  `pandishu-web-1d860.billing_export.v_pandishu_costs`
AS
WITH base AS (
  SELECT
    DATE_TRUNC(DATE(usage_start_time), MONTH)   AS mes,
    IFNULL(service.description, 'Desconocido')  AS servicio,
    IFNULL(sku.description, 'Desconocido')       AS sku,
    -- Extraer el label cost_center de forma segura
    (SELECT value FROM UNNEST(labels) WHERE key = 'cost_center' LIMIT 1)  AS cost_center,
    (SELECT value FROM UNNEST(labels) WHERE key = 'environment' LIMIT 1)  AS environment,
    cost,
    usage.amount                                                           AS uso_amount,
    usage.unit                                                             AS uso_unidad
  FROM
    -- ⚠️ REEMPLAZA `gcp_billing_export_v1_XXXXXX` con tu tabla real
    `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
  WHERE
    project.id = 'pandishu-web-1d860'
    AND DATE(usage_start_time) >= DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH), MONTH)
)

SELECT
  mes,
  servicio,
  sku,
  IFNULL(cost_center, 'sin-etiqueta')  AS cost_center,
  IFNULL(environment, 'sin-etiqueta') AS environment,
  SUM(cost)                            AS costo_usd,
  SUM(cost) * 17.5                     AS costo_mxn,   -- ajusta el tipo de cambio
  SUM(uso_amount)                      AS uso_total,
  MAX(uso_unidad)                      AS unidad
FROM
  base
GROUP BY
  mes, servicio, sku, cost_center, environment
ORDER BY
  mes DESC, costo_usd DESC;


-- =============================================================================
-- PASO 2: Vista especial para tarjeta "Costo del mes actual" en Looker Studio
-- =============================================================================
CREATE OR REPLACE VIEW
  `pandishu-web-1d860.billing_export.v_current_month_summary`
AS
SELECT
  servicio,
  IFNULL(cost_center, 'sin-etiqueta')  AS cost_center,
  SUM(costo_usd)                        AS costo_usd_mes,
  SUM(costo_mxn)                        AS costo_mxn_mes
FROM
  `pandishu-web-1d860.billing_export.v_pandishu_costs`
WHERE
  mes = DATE_TRUNC(CURRENT_DATE(), MONTH)
GROUP BY
  servicio, cost_center
ORDER BY
  costo_usd_mes DESC;


-- =============================================================================
-- PASO 3: Vista de alerta — costo diario de arquitectura de IP fija
--         (Cloud NAT + VPC Connector) para detectar anomalías
-- =============================================================================
CREATE OR REPLACE VIEW
  `pandishu-web-1d860.billing_export.v_nat_daily_alert`
AS
SELECT
  DATE(usage_start_time)          AS dia,
  sku.description                 AS sku,
  SUM(cost)                       AS costo_dia_usd,
  CASE
    WHEN SUM(cost) > 2.0 THEN 'SOBRE_UMBRAL'
    WHEN SUM(cost) > 1.0 THEN 'REVISAR'
    ELSE 'normal'
  END                              AS estado_alerta
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE
  project.id = 'pandishu-web-1d860'
  AND (
    LOWER(sku.description) LIKE '%nat%'
    OR LOWER(sku.description) LIKE '%serverless vpc%'
    OR LOWER(sku.description) LIKE '%external ip%'
  )
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)
GROUP BY
  dia, sku.description
ORDER BY
  dia DESC;
