/**
 * CloudWatch Embedded Metric Format (EMF): a linha de log JSON carrega o bloco
 * `_aws` e o CloudWatch Logs extrai as métricas sozinho, sem PutMetricData nem
 * permissão IAM na Lambda.
 * https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 *
 * O LocalStack não faz essa extração; localmente `extractEmfMetrics` faz o
 * caminho inverso e o agente do local-server publica com PutMetricData.
 */

export function metricNamespace() {
  return `Ecommerce/${process.env.ENVIRONMENT || 'local'}`;
}

/**
 * Campos para juntar à linha de log, a partir de grupos de métricas:
 * { metrics: { Nome: { value, unit } }, dimensions: { Nome: 'valor' },
 *   dimensionSets: listas de nomes de dimensão ([] = métrica sem dimensão) }.
 * Cada grupo vira uma diretiva do `_aws`; valores ficam na raiz da linha.
 */
export function emfFields(groups, timestamp = Date.now()) {
  const directives = [];
  const root = {};
  for (const { metrics = {}, dimensions = {}, dimensionSets = [[]] } of groups) {
    const names = Object.keys(metrics);
    if (!names.length) continue;
    directives.push({
      Namespace: metricNamespace(),
      Dimensions: dimensionSets,
      Metrics: names.map(Name => ({ Name, Unit: metrics[Name].unit || 'Count' }))
    });
    for (const [name, value] of Object.entries(dimensions)) root[name] = String(value);
    for (const name of names) root[name] = metrics[name].value;
  }
  if (!directives.length) return {};
  return { _aws: { Timestamp: timestamp, CloudWatchMetrics: directives }, ...root };
}

/**
 * Inverso de emfFields: lista de MetricDatum (formato do PutMetricData),
 * agrupada por namespace. Uma entrada por métrica × conjunto de dimensões,
 * como o CloudWatch faz.
 */
export function extractEmfMetrics(entry) {
  const directives = entry?._aws?.CloudWatchMetrics;
  if (!Array.isArray(directives)) return [];
  const timestamp = new Date(entry._aws.Timestamp || Date.now());
  const data = [];
  for (const { Namespace, Dimensions = [[]], Metrics = [] } of directives) {
    for (const { Name, Unit } of Metrics) {
      const value = Number(entry[Name]);
      if (!Number.isFinite(value)) continue;
      for (const set of Dimensions.length ? Dimensions : [[]]) {
        if (set.some(name => entry[name] === undefined)) continue;
        data.push({
          Namespace,
          MetricName: Name,
          Value: value,
          Unit: Unit || 'None',
          Timestamp: timestamp,
          Dimensions: set.map(Name => ({ Name, Value: String(entry[Name]) }))
        });
      }
    }
  }
  return data;
}
