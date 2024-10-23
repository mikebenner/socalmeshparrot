import crypto from "crypto";
import path from "path";
import mqtt from "mqtt";
import protobufjs from "protobufjs";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import FifoKeyCache from "./src/FifoKeyCache";
import MeshPacketQueue, { PacketGroup } from "./src/MeshPacketQueue";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { createClient } from "redis";
import { env } from "process";

// Generate a pseudo UUID to use as an instance ID
const INSTANCE_ID = (() => {
  return crypto.randomBytes(4).toString("hex");
})();

function loggerDateString() {
  return process.env.ENVIRONMENT === "production"
    ? ""
    : new Date().toISOString() + " ";
}

const logger = {
  info: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [INFO] ${message}`);
  },
  error: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [ERROR] ${message}`);
  },
  debug: (message: string) => {
    console.log(`${loggerDateString()}[${INSTANCE_ID}] [DEBUG] ${message}`);
  },
};

// Initialize Sentry
Sentry.init({
  environment: process.env.ENVIRONMENT || "development",
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0, // Capture 100% of transactions
  profilesSampleRate: 1.0, // Set profiling sample rate
});

Sentry.setTag("instance_id", INSTANCE_ID);

logger.info(`Starting Rage Against Mesh(ine) ${INSTANCE_ID}`);

let pfpDb = { default: "https://cdn.discordapp.com/embed/avatars/0.png" };

if (process.env.PFP_JSON_URL) {
  logger.info(`Using PFP_JSON_URL=${process.env.PFP_JSON_URL}`);
  axios.get(process.env.PFP_JSON_URL).then((response) => {
    pfpDb = response.data;
    logger.info(`Loaded ${Object.keys(pfpDb).length} pfp entries`);
  });
}

const mqttBrokerUrl = "mqtt://mqtt.bayme.sh";
const mqttUsername = "meshdev";
const mqttPassword = "large4cats";

// Create Redis Client with Azure Cache for Redis URL and SSL enabled
const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    tls: true, // Enable SSL/TLS
  },
});

(async () => {
  if (process.env.REDIS_ENABLED === "true") {
    // Connect to the Redis server
    await redisClient.connect();
    logger.info(`Connected to Redis instance at ${process.env.REDIS_URL}`);
    logger.info(`Setting active instance id to ${INSTANCE_ID}`);
    await redisClient.set(`baymesh:active`, INSTANCE_ID);
  }
})();

const decryptionKeys = [
  "1PG7OiApB1nwvP+rz05pAQ==", // Add default "AQ==" decryption key
];

const nodeDB = JSON.parse(fs.readFileSync("./nodeDB.json").toString());
const ignoreDB = JSON.parse(fs.readFileSync("./ignoreDB.json").toString());
const cache = new FifoKeyCache();
const meshPacketQueue = new MeshPacketQueue();

const updateNodeDB = (
  node: string,
  longName: string,
  nodeInfo: any,
  hopStart: number,
) => {
  try {
    nodeDB[node] = longName;
    if (process.env.REDIS_ENABLED === "true") {
      redisClient.set(`baymesh:node:${node}`, longName);
      const nodeInfoGenericObj = JSON.parse(JSON.stringify(nodeInfo));
      // remove leading "!" from id
      nodeInfoGenericObj.id = nodeInfoGenericObj.id.replace("!", "");
      // add hopStart to nodeInfo
      nodeInfoGenericObj.hopStart = hopStart;
      nodeInfoGenericObj.updatedAt = new Date().getTime();
      redisClient.json
        .set(`baymesh:nodeinfo:${node}`, "$", nodeInfoGenericObj)
        .catch(async (err) => {
          // Handle Redis key type mismatch
          const result = await redisClient.type(`baymesh:nodeinfo:${node}`);
          logger.info(result);
          if (result === "string") {
            await redisClient.del(`baymesh:nodeinfo:${node}`);
            await redisClient.json.set(
              `baymesh:nodeinfo:${node}`,
              "$",
              nodeInfoGenericObj,
            );
            logger.info("Deleted and re-added node info for: " + node);
          }
          logger.error(`Redis key: baymesh:nodeinfo:${node} ${err}`);
        });
    }
    fs.writeFileSync(
      path.join(__dirname, "./nodeDB.json"),
      JSON.stringify(nodeDB, null, 2),
    );
  } catch (err) {
    Sentry.captureException(err);
  }
};

const isInIgnoreDB = (node: string) => {
  return ignoreDB.includes(node);
};

const getNodeInfos = async (nodeIds: string[], debug: boolean) => {
  try {
    nodeIds = Array.from(new Set(nodeIds));
    const nodeInfos = await redisClient.json.mGet(
      nodeIds.map((nodeId) => `baymesh:nodeinfo:${nodeId2hex(nodeId)}`),
      "$",
    );
    if (debug) {
      logger.debug(JSON.stringify(nodeInfos));
    }
    const formattedNodeInfos = nodeInfos.flat().reduce((acc, item) => {
      if (item && item.id) {
        acc[item.id] = item;
      }
      return acc;
    }, {});
    if (Object.keys(formattedNodeInfos).length !== nodeIds.length) {
      const missingNodes = nodeIds.filter((nodeId) => {
        return formattedNodeInfos[nodeId] === undefined;
      });
      logger.info("Missing nodeInfo for nodes: " + missingNodes.join(","));
    }
    return formattedNodeInfos;
  } catch (err) {
    Sentry.captureException(err);
  }
  return {};
};

const getNodeName = (nodeId: string | number) => {
  return nodeDB[nodeId2hex(nodeId)] || "Unknown";
};

const nodeId2hex = (nodeId: string | number) => {
  return typeof nodeId === "number"
    ? nodeId.toString(16).padStart(8, "0")
    : nodeId;
};

const nodeHex2id = (nodeHex: string) => {
  return parseInt(nodeHex, 16);
};

const prettyNodeName = (nodeId: string | number) => {
  const nodeIdHex = nodeId2hex(nodeId);
  const nodeName = getNodeName(nodeId);
  return nodeName ? `${nodeIdHex} - ${nodeName}` : nodeIdHex;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load protobufs
const root = new protobufjs.Root();
root.resolvePath = (origin, target) =>
  path.join(__dirname, "src/protobufs", target);
root.loadSync("meshtastic/mqtt.proto");
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");
const User = root.lookupType("User");

if (!process.env.DISCORD_WEBHOOK_URL) {
  logger.error("DISCORD_WEBHOOK_URL not set");
  process.exit(-1);
}

const baWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const svWebhookUrl = process.env.SV_DISCORD_WEBHOOK_URL;

const grouping_duration = parseInt(process.env.GROUPING_DURATION || "10000");

function sendDiscordMessage(webhookUrl: string, payload: any) {
  const data = typeof payload === "string" ? { content: payload } : payload;

  return axios
    .post(webhookUrl, data)
    .catch((error) => {
      logger.error(
        `[error] Could not send discord message: ${error.response.status}`,
      );
    });
}

function processTextMessage(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const text = packet.decoded.payload.toString();
  logger.debug("createDiscordMessage: " + text);
  createDiscordMessage(packetGroup, text);
}

const createDiscordMessage = async (packetGroup, text) => {
  try {
    const packet = packetGroup.serviceEnvelopes[0].packet;
    const to = nodeId2hex(packet.to);
    const from = nodeId2hex(packet.from);
    const nodeIdHex = nodeId2hex(from);

    if (text.match(/^seq \d+$/)) {
      return;
    }

    if (isInIgnoreDB(from)) {
      logger.info(
        `MessageId: ${packetGroup.id} Ignoring message from ${prettyNodeName(
          from,
        )} to ${prettyNodeName(to)} : ${text}`,
      );
      return;
    }

    if (new Date(packet.rxTime * 1000) < new Date(Date.now() - 5 * 60 * 1000)) {
      logger.info(
        `MessageId: ${packetGroup.id} Ignoring old message from ${prettyNodeName(
          from,
        )} to ${prettyNodeName(to)} : ${text}`,
      );
    }
