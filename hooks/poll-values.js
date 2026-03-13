const NormalSdk = require("@normalframework/applications-sdk");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser();

/**
 * poll-values hook
 * Scheduled run: fetches the current presentValue from each registered
 * R2 Jace XML endpoint and writes the data into Normal.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config, points }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("baseUrl is required");
  }

  const base = config.baseUrl.replace(/\/+$/, "");
  const authConfig = (config.username && config.password)
    ? { auth: { username: config.username, password: config.password } }
    : {};

  // Filter to only data points (not the device-level point)
  const dataPoints = points.filter(p => p.point_type === "POINT" && p.attrs?.path);

  sdk.logEvent(`Polling ${dataPoints.length} points from ${base}`);

  let updates = 0;
  let errors = 0;
  const ts = new Date().toISOString();

  for (const point of dataPoints) {
    const link = point.attrs.path;
    try {
      const { data: xml } = await axios.get(`${base}${link}`, {
        ...authConfig,
        timeout: 5000,
      });

      const doc = parser.parse(xml)?.nodeDump;
      if (!doc) continue;

      // Extract the final presentValue (last occurrence in the XML)
      let rawVal = doc.presentValue;
      if (rawVal === undefined || rawVal === null) continue;

      const val = parseFloat(rawVal);
      if (isNaN(val)) continue;

      await axios.post(`http://${process.env.NFURL}/api/v1/point/data`, {
        uuid: point.uuid,
        layer: "hpl:niagarar2",
        values: [{ ts, real: val }]
      }, { timeout: 10000 });

      updates++;
    } catch (e) {
      sdk.logEvent(`Poll error on ${link}: ${e.message}`);
      errors++;
    }
  }

  sdk.logEvent(`Poll complete: ${updates} values written, ${errors} errors`);
};
