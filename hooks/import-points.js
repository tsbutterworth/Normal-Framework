const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const NAMESPACE = "a1b2c3d4-1234-5678-abcd-ef1234567890";
const BATCH_SIZE = 100;
const parser = new XMLParser();

/**
 * import-points hook
 * One-time (or on-demand) run: discovers all points from the R2 Jace
 * station index at /db, fetches each XML endpoint, and registers
 * them as points in Normal.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config }) => {
  if (!config.baseUrl) {
    return NormalSdk.InvokeError("baseUrl is required");
  }

  const base = config.baseUrl.replace(/\/+$/, "");
  const authConfig = (config.username && config.password)
    ? { auth: { username: config.username, password: config.password } }
    : {};

  sdk.logEvent(`Fetching station index from ${base}/db`);

  // 1. Fetch the station index HTML and extract all /prism/xml/... hrefs
  const { data: html } = await axios.get(`${base}/db`, {
    ...authConfig,
    timeout: 30000,
  });

  const linkPattern = /href="(\/prism\/xml\/[^"]+)"/g;
  const links = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    links.push(match[1]);
  }

  sdk.logEvent(`Found ${links.length} XML endpoints`);

  // 2. Register a device-level point so Device Health works
  await axios.post(`http://${process.env.NFURL}/api/v1/point/points`, {
    points: [{
      layer: "hpl:niagarar2",
      uuid: NAMESPACE,
      parent_uuid: NAMESPACE,
      name: base,
      point_type: "DEVICE",
    }]
  }, { timeout: 15000 });

  // 3. Fetch each XML endpoint and register the point
  let batch = [];
  let imported = 0;
  let errors = 0;

  for (const link of links) {
    try {
      const { data: xml } = await axios.get(`${base}${link}`, {
        ...authConfig,
        timeout: 5000,
      });

      const doc = parser.parse(xml)?.nodeDump;
      if (!doc) continue;

      // Only register points that have a presentValue
      const rawVal = doc.presentValue;
      if (rawVal === undefined || rawVal === null) continue;

      const objectType = doc.objectType || "Unknown";
      const units = doc.units || "";
      const parts = link.split("/");
      const pointName = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join("/");
      const uuid = uuidv5(link, NAMESPACE);

      batch.push({
        layer: "hpl:niagarar2",
        uuid,
        name: pointName,
        parent_uuid: NAMESPACE,
        parent_name: parentPath,
        protocol_id: link,
        attrs: { path: link, objectType, units },
        point_type: "POINT",
      });

      if (batch.length >= BATCH_SIZE) {
        await axios.post(`http://${process.env.NFURL}/api/v1/point/points`,
          { points: batch }, { timeout: 30000 });
        imported += batch.length;
        sdk.logEvent(`Imported ${imported} points so far...`);
        batch = [];
      }
    } catch (e) {
      sdk.logEvent(`Error on ${link}: ${e.message}`);
      errors++;
    }
  }

  // Flush remaining batch
  if (batch.length > 0) {
    await axios.post(`http://${process.env.NFURL}/api/v1/point/points`,
      { points: batch }, { timeout: 30000 });
    imported += batch.length;
  }

  sdk.logEvent(`Import complete: ${imported} points registered, ${errors} errors`);
};
