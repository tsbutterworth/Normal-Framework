const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

// Root namespace — used to derive a stable per-JACE namespace from its URL
const ROOT_NAMESPACE = "a1b2c3d4-1234-5678-abcd-ef1234567890";
const BATCH_SIZE = 100;
const parser = new XMLParser();

/**
 * import-points hook
 * One-time (or on-demand) run: discovers all points from one or more R2 Jace
 * stations. baseUrl may be a single URL or a comma-separated list of URLs.
 * Each JACE gets its own UUID namespace derived from its URL so points
 * from different JACEs never collide.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config }) => {
    if (!config.baseUrl) {
          return NormalSdk.InvokeError("baseUrl is required");
    }

    const authConfig = (config.username && config.password)
      ? { auth: { username: config.username, password: config.password } }
          : {};

    // Support comma-separated list of base URLs for multiple JACEs
    const bases = config.baseUrl
      .split(",")
      .map(u => u.trim().replace(/\/+$/, ""))
      .filter(Boolean);

    sdk.logEvent(`Starting import for ${bases.length} JACE(s)`);

    let totalImported = 0;
    let totalErrors = 0;

    for (const base of bases) {
          // Derive a stable per-JACE namespace from its URL
      const jaceNamespace = uuidv5(base, ROOT_NAMESPACE);

      sdk.logEvent(`Fetching station index from ${base}/db`);

      // 1. Fetch the station index HTML and extract all /prism/xml/... hrefs
      let html;
          try {
                  const res = await axios.get(`${base}/db`, {
                            ...authConfig,
                            timeout: 30000,
                  });
                  html = res.data;
          } catch (e) {
                  sdk.logEvent(`Error fetching station index for ${base}: ${e.message}`);
                  totalErrors++;
                  continue;
          }

      const linkPattern = /href="(\/prism\/xml\/[^"]+)"/g;
          const links = [];
          let match;
          while ((match = linkPattern.exec(html)) !== null) {
                  links.push(match[1]);
          }

      sdk.logEvent(`Found ${links.length} XML endpoints on ${base}`);

      // 2. Register a device-level point so Device Health works
      await axios.post(`http://${process.env.NFURL}/api/v1/point/points`, {
              points: [{
                        layer: "hpl:niagarar2",
                        uuid: jaceNamespace,
                        parent_uuid: jaceNamespace,
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
                        const uuid = uuidv5(link, jaceNamespace);

                batch.push({
                            layer: "hpl:niagarar2",
                            uuid,
                            name: pointName,
                            parent_uuid: jaceNamespace,
                            parent_name: parentPath,
                            protocol_id: link,
                            attrs: { path: link, objectType, units, jaceUrl: base },
                            point_type: "POINT",
                });

                if (batch.length >= BATCH_SIZE) {
                            await axios.post(`http://${process.env.NFURL}/api/v1/point/points`,
                                             { points: batch }, { timeout: 30000 });
                            imported += batch.length;
                            sdk.logEvent(`Imported ${imported} points from ${base} so far...`);
                            batch = [];
                }
              } catch (e) {
                        sdk.logEvent(`Error on ${base}${link}: ${e.message}`);
                        errors++;
              }
      }

      // Flush remaining batch
      if (batch.length > 0) {
              await axios.post(`http://${process.env.NFURL}/api/v1/point/points`,
                               { points: batch }, { timeout: 30000 });
              imported += batch.length;
      }

      sdk.logEvent(`${base}: ${imported} points registered, ${errors} errors`);
          totalImported += imported;
          totalErrors += errors;
    }

    sdk.logEvent(`Import complete: ${totalImported} total points registered across ${bases.length} JACE(s), ${totalErrors} total errors`);
};
