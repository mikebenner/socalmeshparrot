# Rage Against The Mesh(ine)
a discord bot for meshtastic

Most of the bot logic is in https://github.com/baymesh/ratm-meshtastic-discord-bot/blob/main/index.ts

There is a Dockerfile, you can deploy this anywhere that you can run docker containers?

Or you can set the environment variables and run `tsx index.js`

## Enviroment Variables

| Key      | Description      |
| ------------- | ------------- |
|`DISCORD_WEBHOOK_URL`| discord webhook url for where to send Bay Mesh messages|
|`GROUPING_DURATION` | how long the logger will wait for packets for a new message that it sees|
|`PFP_JSON_URL` | json file that links node ids to profile images, example [here](https://raw.githubusercontent.com/baymesh/bot_pfp/refs/heads/main/baymesh_pfp.json)|
