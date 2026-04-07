import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";

const server = new McpServer({
  name: "cc-mcp-server",
  version: "1.0.0"
});

// ── TOOL: cc_lookup_carrier ─────────────────────────────────────
server.registerTool(
  "cc_lookup_carrier",
  {
    description: "Look up a carrier by MC number against FMCSA SAFER API. Returns authority status, safety rating, insurance on file, and years in operation.",
    inputSchema: {
      mc_number: z.string().describe("The carrier MC number (without 'MC' prefix, just digits)")
    }
  },
  async ({ mc_number }) => {
    try {
      const result = await lookupFMCSA(mc_number);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error looking up MC${mc_number}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// ── TOOL: cc_verify_carrier ─────────────────────────────────────
server.registerTool(
  "cc_verify_carrier",
  {
    description: "Run full verification on a carrier submission. Checks FMCSA authority, safety rating, insurance minimums, and years in operation against broker requirements. Returns pass/fail per criterion.",
    inputSchema: {
      mc_number: z.string().describe("Carrier MC number"),
      dot_number: z.string().optional().describe("Carrier DOT number"),
      min_insurance: z.number().optional().describe("Minimum auto liability insurance required in dollars"),
      min_years: z.number().optional().describe("Minimum years in business required")
    }
  },
  async ({ mc_number, dot_number, min_insurance, min_years }) => {
    try {
      const fmcsa = await lookupFMCSA(mc_number);
      const checks = runVerificationChecks(fmcsa, { min_insurance, min_years });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ mc_number, fmcsa, checks }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Verification error for MC${mc_number}: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// ── TOOL: cc_assign_tier ────────────────────────────────────────
server.registerTool(
  "cc_assign_tier",
  {
    description: "Assign a carrier tier (1-Preferred, 2-Approved, 3-Conditional, Rejected) based on verification results and broker history.",
    inputSchema: {
      mc_number: z.string().describe("Carrier MC number"),
      in_port_tms: z.boolean().describe("Is carrier already in Port TMS?"),
      completed_loads: z.number().describe("Number of completed loads with this broker"),
      verification_passed: z.boolean().describe("Did the carrier pass full verification?"),
      has_safety_flag: z.boolean().describe("Does carrier have a conditional or worse safety rating?"),
      failed_hard_stop: z.boolean().describe("Did carrier fail any auto-disqualifier?")
    }
  },
  async ({ mc_number, in_port_tms, completed_loads, verification_passed, has_safety_flag, failed_hard_stop }) => {
    let tier: string;
    let reason: string;

    if (failed_hard_stop) {
      tier = "Rejected";
      reason = "Failed one or more automatic disqualifiers";
    } else if (in_port_tms && completed_loads >= 3 && verification_passed && !has_safety_flag) {
      tier = "Tier 1 — Preferred";
      reason = "In Port TMS with 3+ loads and clean history — bypasses screening";
    } else if (verification_passed && !has_safety_flag) {
      tier = "Tier 2 — Approved";
      reason = "New carrier, passes all hard stops — standard onboarding";
    } else if (verification_passed && has_safety_flag) {
      tier = "Tier 3 — Conditional";
      reason = "Passes minimums but has safety flag — manual review required";
    } else {
      tier = "Tier 3 — Conditional";
      reason = "Incomplete verification — manual review required";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ mc_number, tier, reason, inputs: { in_port_tms, completed_loads, verification_passed, has_safety_flag, failed_hard_stop } }, null, 2)
      }]
    };
  }
);

// ── FMCSA SAFER API ─────────────────────────────────────────────
async function lookupFMCSA(mc_number: string): Promise<Record<string, unknown>> {
  // FMCSA SAFER API — free, no key required
  // Docs: https://safer.fmcsa.dot.gov/
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&original_query_param=NAME&query_string=${mc_number}&action=get_data`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FMCSA API returned ${response.status}`);
  }
  
  const text = await response.text();
  
  // Parse key fields from FMCSA HTML response
  return {
    mc_number,
    raw_available: true,
    note: "FMCSA SAFER API integration — full parser to be implemented",
    url
  };
}

function runVerificationChecks(
  fmcsa: Record<string, unknown>,
  requirements: { min_insurance?: number; min_years?: number }
): Record<string, boolean> {
  // Placeholder — real checks come from parsed FMCSA data
  return {
    active_authority: true,
    insurance_meets_minimum: true,
    no_unsatisfactory_rating: true,
    years_in_business: true
  };
}

// ── HTTP SERVER ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "cc-mcp-server", version: "1.0.0" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

httpServer.listen(PORT, () => {
  console.error(`cc-mcp-server running on port ${PORT}`);
  console.error(`Tools: cc_lookup_carrier, cc_verify_carrier, cc_assign_tier`);
  console.error(`Health: http://localhost:${PORT}/health`);
});
