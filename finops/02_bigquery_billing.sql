-- =============================================================================
-- Pandishú FinOps — BigQuery Billing Queries (Pilar OPERATE)
-- Dataset: pandishu-web-1d860.billing_export
-- Tabla:   gcp_billing_export_v1_XXXXXX (reemplaza con tu tabla real tras activar el export)
--
-- Para activar el export:
--   Facturación → Exportar presupuesto → Standard Usage Cost → BigQuery
--   Dataset: billing_export (regíon US)
-- =============================================================================

-- =============================================================================
-- QUERY 1: Costo mensual desglosado por servicio (Vista general)
-- =============================================================================
SELECT
  FORMAT_DATE('%Y-%m', DATE(usage_start_time)) AS mes,
  service.description                          AS servicio,
  SUM(cost)                                    AS costo_usd,
  SUM(cost) * 17.5                             AS costo_mxn_estimado -- Ajusta el tipo de cambio
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE
  project.id = 'pandishu-web-1d860'
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
GROUP BY
  mes, servicio
ORDER BY
  mes DESC, costo_usd DESC;


-- =============================================================================
-- QUERY 2: Costo específico del Cloud NAT y VPC Connector
--          (Monitoreo de la IP fija — tu costo de producción CT)
-- =============================================================================
SELECT
  FORMAT_DATE('%Y-%m', DATE(usage_start_time)) AS mes,
  service.description                          AS servicio,
  sku.description                              AS sku,
  SUM(cost)                                    AS costo_usd,
  SUM(cost) * 17.5                             AS costo_mxn_estimado
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE
  project.id = 'pandishu-web-1d860'
  AND (
    -- Cloud NAT
    LOWER(sku.description) LIKE '%nat%'
    -- VPC Connector (Serverless VPC Access)
    OR LOWER(sku.description) LIKE '%serverless vpc%'
    OR LOWER(sku.description) LIKE '%vpc connector%'
    -- IPs estáticas reservadas
    OR LOWER(sku.description) LIKE '%external ip%'
  )
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
GROUP BY
  mes, servicio, sku
ORDER BY
  mes DESC, costo_usd DESC;


-- =============================================================================
-- QUERY 3: Costo de Cloud Functions desglosado por función
--          (Permite ver qué función es más cara de ejecutar)
-- =============================================================================
SELECT
  FORMAT_DATE('%Y-%m', DATE(usage_start_time)) AS mes,
  sku.description                              AS sku,
  SUM(cost)                                    AS costo_usd,
  SUM(usage.amount)                            AS invocaciones_aprox,
  usage.unit                                   AS unidad
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE
  project.id = 'pandishu-web-1d860'
  AND service.description LIKE '%Cloud Functions%'
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
GROUP BY
  mes, sku, unidad
ORDER BY
  mes DESC, costo_usd DESC;


-- =============================================================================
-- QUERY 4: ALERTA — Gasto diario de IP Fija vs umbral ($2 USD/día)
--          Útil para detectar si el Cloud NAT está procesando tráfico inesperado
-- =============================================================================
SELECT
  DATE(usage_start_time)    AS dia,
  SUM(cost)                 AS costo_dia_usd,
  CASE
    WHEN SUM(cost) > 2.0 THEN '⚠️ SOBRE UMBRAL'
    ELSE '✅ Normal'
  END                        AS estado
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`
WHERE
  project.id = 'pandishu-web-1d860'
  AND (
    LOWER(sku.description) LIKE '%nat%'
    OR LOWER(sku.description) LIKE '%serverless vpc%'
    OR LOWER(sku.description) LIKE '%external ip%'
  )
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
GROUP BY
  dia
ORDER BY
  dia DESC;


-- =============================================================================
-- QUERY 5: Vista por etiqueta (labels) — funciona UNA VEZ que etiquetes los recursos
-- =============================================================================
SELECT
  FORMAT_DATE('%Y-%m', DATE(usage_start_time))                               AS mes,
  label.value                                                                AS cost_center,
  service.description                                                        AS servicio,
  SUM(cost)                                                                  AS costo_usd
FROM
  `pandishu-web-1d860.billing_export.gcp_billing_export_v1_XXXXXX`,
  UNNEST(labels) AS label
WHERE
  label.key = 'cost_center'
  AND project.id = 'pandishu-web-1d860'
  AND DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL 3 MONTH)
GROUP BY
  mes, cost_center, servicio
ORDER BY
  mes DESC, costo_usd DESC;
