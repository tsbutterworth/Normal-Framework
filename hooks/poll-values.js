const NormalSdk = require("@normalframework/applications-sdk");
const { v5: uuidv5 } = require("uuid");
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

// Root namespace — must match import-points.js so UUIDs resolve correctly
const ROOT_NAMESPACE = "a1b2c3d4-1234-5678-abcd-ef1234567890";
const parser = new XMLParser();

/**
 * poll-values hook
 * Scheduled run: fetches the current presentValue from each registered
 * R2 Jace XML endpoint and writes the data into Normal.
 * Supports multiple JACEs — each point carries a jaceUrl attr set
 * during import, which is used to route requests to the correct JACE.
 *
 * @param {NormalSdk.InvokeParams} params
 * @returns {NormalSdk.InvokeResult}
 */
module.exports = async ({ sdk, config, points }) => {
    if (!config.baseUrl) {
          return NormalSdk.InvokeError("baseUrl is required");
    }

    const authConfig = (config.username && config.password)
      ? { auth: { username: config.username, password: config.password } }
          : {};

    // Build a set of known base URLs for validation
    const knownBases = new Set(
          config.baseUrl
            .split(",")
            .map(u => u.trim().replace(/\/+$/, ""))
            .filter(Boolean)
        );

    // Filter to only data points that have a path attr
    const dataPoints = points.filter(p => p.point_type === "POINT" && p.attrs?.path);

    sdk.logEvent(`Polling ${dataPoints.length} points across ${knownBases.size} JACE(s)`);

    let updates = 0;
    let errors = 0;
    const ts = new Date().toISOString();

    for (const point of dataPoints) {
          const link = point.attrs.path;

      // Determine which JACE this point belongs to.
      // Prefer the jaceUrl attr stored during import; fall back to
      // deriving it from the point's parent UUID if needed.
      let base = point.attrs.jaceUrl;

      // If jaceUrl attr is missing (legacy points), derive from parent UUID
      if (!base) {
              for (const b of knownBases) {
                        const ns = uuidv5(b, ROOT_NAMESPACE);
                        if (point.parent_uuid === ns) {
                                    base = b;
                                    break;
                        }
              }
      }

      if (!base) {
              sdk.logEvent(`Cannot determine JACE URL for point ${link}, skipping`);
              errors++;
              continue;
      }

      try {
              const { data: xml } = await axios.get(`${base}${link}`, {
                        ...authConfig,
                        timeout: 5000,
              });

            const doc = parser.parse(xml)?.nodeDump;
              if (!doc) continue;

            // Extract the present value
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
              sdk.logEvent(`Poll error on ${base}${link}: ${e.message}`);
              errors++;
      }
    }

    sdk.logEvent(`Poll complete: ${updates} values written, ${errors} errors`);
};
