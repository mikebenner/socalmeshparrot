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
import { env } from "process";

// In-memory storage to replace Redis
const inMemoryStore = new Map();

// generate a pseudo-uuid for the instance
const INSTANCE_ID = crypto.randomBytes(4).toString("hex");

function loggerDateString() {
  return process.env.ENVIRONMENT === "production" ? "" : new Date().toISOString() + " ";
}

const logger = {
  info: (message: string) => console.log(`${loggerDateString()}[${INSTANCE_ID}] [INFO] ${message}`),
  error: (message: string) => console.log(`${loggerDateString()}[${INSTANCE_ID}] [ERROR] ${message}`),
  debug: (message: string) => console.log(`${loggerDateString()}[${INSTANCE_ID}] [DEBUG] ${message}`),
};

Sentry.init({
  environment: process.env.ENVIRONMENT || "development",
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
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

const decryptionKeys = ["1PG7OiApB1nwvP+rz05pAQ=="]; // default decryption key

const nodeDB = JSON.parse(fs.readFileSync("./nodeDB.json").toString());
const ignoreDB = JSON.parse(fs.readFileSync("./ignoreDB.json").toString());
const cache = new FifoKeyCache();
const meshPacketQueue = new MeshPacketQueue();

// Update nodeDB and cache node info in-memory
const updateNodeDB = (node: string, longName: string, nodeInfo: any, hopStart: number) => {
  try {
    nodeDB[node] = longName;

    const nodeInfoGenericObj = JSON.parse(JSON.stringify(nodeInfo));
    nodeInfoGenericObj.id = nodeInfoGenericObj.id.replace("!", "");
    nodeInfoGenericObj.hopStart = hopStart;
    nodeInfoGenericObj.updatedAt = new Date().getTime();

    // In-memory cache update
    inMemoryStore.set(`node:${node}`, longName);
    inMemoryStore.set(`nodeinfo:${node}`, nodeInfoGenericObj);

    fs.writeFileSync(path.join(__dirname, "./nodeDB.json"), JSON.stringify(nodeDB, null, 2));
  } catch (err) {
    Sentry.captureException(err);
  }
};

const isInIgnoreDB = (node: string) => {
  return ignoreDB.includes(node);
};

// Fetch node info from in-memory store
const getNodeInfos = async (nodeIds: string[], debug: boolean) => {
  try {
    nodeIds = Array.from(new Set(nodeIds));

    // Fetch nodeInfos from the in-memory store
    const nodeInfos = nodeIds.map((nodeId) => inMemoryStore.get(`nodeinfo:${nodeId2hex(nodeId)}`));

    const formattedNodeInfos = nodeInfos.reduce((acc, item) => {
      if (item && item.id) {
        acc[item.id] = item;
      }
      return acc;
    }, {});

    if (Object.keys(formattedNodeInfos).length !== nodeIds.length) {
      const missingNodes = nodeIds.filter((nodeId) => formattedNodeInfos[nodeId] === undefined);
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
  return typeof nodeId === "number" ? nodeId.toString(16).padStart(8, "0") : nodeId;
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
root.resolvePath = (origin, target) => path.join(__dirname, "src/protobufs", target);
root.loadSync("meshtastic/mqtt.proto");
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");

const baWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const svWebhookUrl = process.env.SV_DISCORD_WEBHOOK_URL;

const grouping_duration = parseInt(process.env.GROUPING_DURATION || "10000");

// Simulate the Redis-based function for checking active instance
const checkActiveInstance = () => {
  const activeInstance = inMemoryStore.get("active");
  return activeInstance && activeInstance !== INSTANCE_ID;
};

// Run every 5 seconds to process the queue
const processing_timer = setInterval(() => {
  if (checkActiveInstance()) {
    logger.error(`Stopping RATM instance; active instance is not ${INSTANCE_ID}`);
    clearInterval(processing_timer);
    return;
  }

  const packetGroups = meshPacketQueue.popPacketGroupsOlderThan(Date.now() - grouping_duration);
  packetGroups.forEach((packetGroup) => {
    processPacketGroup(packetGroup);
  });
}, 5000);

const baymesh_client = mqtt.connect(mqttBrokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
});

// Subscribe to MQTT topics
baymesh_client.on("connect", () => {
  logger.info(`Connected to Private MQTT broker`);
  subbed_topics.forEach((topic) => sub(baymesh_client, topic));
});

// Handle received messages
baymesh_client.on("message", async (topic: string, message: any) => {
  try {
    if (topic.includes("msh")) {
      // Message handling code...
    }
  } catch (err) {
    logger.error("Error: " + String(err));
    Sentry.captureException(err);
  }
});

// ... Rest of the code (decrypt, processPacketGroup, etc.) remains unchanged
