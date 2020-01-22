const tjs = require('teslajs');
const yargs = require('yargs');
const WebSocket = require('ws');
const moment = require('moment');
var JSONbig = require('json-bigint');
const { CogniteClient } = require('@cognite/sdk');

const stream_columns = ['speed', 'odometer', 'soc', 'elevation', 'est_heading', 'est_lat', 'est_lng', 'power', 'shift_state', 'range', 'est_range', 'heading'];
// heading and est_heading are swapped because est_heading is the one matching regular API.
const stream_columns_alias = ['speed', 'odometer', 'battery_level', 'elevation', 'heading', 'latitude', 'longitude', 'power', 'shift_state', 'battery_range', 'est_battery_range', 'est_heading'];  

let is_streaming = false;

const argv = yargs
    .command('--username', 'Username for your Tesla account')
    .command('--password', 'Password for your Tesla account')
    .command('--token', 'Token for your Tesla account')
    .command('--project', 'Cognite project')
    .command('--apikey', 'API key for Cognite project')
    .command('--vehicleindex', 'Index of vehicles to sample for.')
    .command('--listvehicles', 'List vehicles')
    .command('--gettoken', 'Get Tesla oauth token')
    .help()
    .alias('help', 'h')
    .alias('username', 'u')
    .alias('password', 'p')
    .alias('apikey', 'a')
    .alias('token', 't')
    .argv;

function createAssetHierarchy(cogniteClient) {

}

const getToken = async (username, password) => {
  const result = await tjs.loginAsync(username, password);
  if (result.error) {
    console.log(JSON.stringify(result.error));
    process.exit(1);
  }

  // var token = JSON.stringify(result.authToken);
  return result.authToken;
}

const startStreaming = async (options, onError, onMessage) => {
  const { token, client, vehicle } = options;
  let ws = new WebSocket('wss://streaming.vn.teslamotors.com/streaming/', {
		followRedirects: true,
  });
  
  const msg = {
		msg_type: 'data:subscribe',
		token: new Buffer.from(options.username + ':' + vehicle.tokens[0]).toString('base64'),
		value: stream_columns.join(','),
		tag: vehicle.vehicle_id.toString(),
  };
  
  ws.on('open', () => {
		ws.send(JSON.stringify(msg));
	});
	
	ws.on('close', (code, reason) => {
		console.log('websocket closed, code=' + code + ', reason=' + reason);
  });
  
  ws.on('error', onError);
  ws.on('message', onMessage);
}

const insertDataPoints = async (client, data, timeseriesNames) => {
  const convertMilesToKM = ["speed", "est_battery_range", "ideal_battery_range", "odometer"]
  const items = [];

  Object.entries(data).map(([key, value]) => {
    if (timeseriesNames.indexOf(key) === -1) {
      // console.log("Skipping ", key);
      return;
    }

    if (key === "shift_state" && value == null) {
      return;
    }
    
    if (key === "not_enough_power_to_heat" && value == null) {
      return;
    }

    if (typeof value === "boolean"){
      value = key ? 1 : 0;
    }

    if (key === "speed" && (value == null || value === "")) {
      value = 0.0;
    }

    if (convertMilesToKM.indexOf(key) !== -1) {
      value *= 1.609344;
    }

    if (typeof value !== "string" && typeof value !== "number") {
      // console.log(`Skipping ${key} because it has value ${value}`);
      return;
    }

    items.push({
      externalId: key,
      datapoints: [{timestamp: data["timestamp"], value: value}]
    })
  });
  client.datapoints.insert(items)
  console.log(`${moment.utc().format('YYYY/MM/D, HH:mm:ss.SSS')} Inserted ${items.length} data points (${data["speed"]}, ${data["power"]})`)
}

const fetchData = async (token, vehicleID) => {
  const [vehicleState, driveState, chargeState, climateState] = await Promise.all([
    tjs.vehicleStateAsync({authToken: token, vehicleID: vehicleID}),
    tjs.driveStateAsync({authToken: token, vehicleID: vehicleID}),
    tjs.chargeStateAsync({authToken: token, vehicleID: vehicleID}),
    tjs.climateStateAsync({authToken: token, vehicleID: vehicleID})
  ]);

  const byKey = {};
  Object.entries(vehicleState).map(([key, value]) => {byKey[key] = value});
  Object.entries(driveState).map(([key, value]) => {byKey[key] = value});
  Object.entries(chargeState).map(([key, value]) => {byKey[key] = value});
  Object.entries(climateState).map(([key, value]) => {byKey[key] = value});
  
  return byKey;
}

const sample = async (options, prevState) => {
  let nextSampleAt = 1000;
  try {
    const { client, timeseriesNames } = options;
    let { vehicle, token } = options;
    if (!token) {
      token = await getToken(options.username, options.password);
    }

    if (!vehicle) {
      console.log("Fetching vehicles...");
      const vehicles = await tjs.vehiclesAsync({ authToken: token })
      vehicle = vehicles[options.vehicleIndex];
      console.log("Using vehicle ", vehicle);
    }
    const data = await fetchData(token, vehicle.id_s);
    insertDataPoints(client, data, timeseriesNames);
    
    options = {token, username, client, timeseriesNames, vehicle};
    state = {
      isDriving: data.shift_state != null,
      isCharging: data.time_to_full_charge > 0,
      isSleeping: data.state === "asleep"
    }

    if (state.isCharging || state.isDriving) {
      nextSampleAt = 0;
    }

    if (
      state.isSleeping || 
      (!state.isDriving && prevState.isDriving)
    ) {
      // If we are sleeping, or the car just went from driving to not driving, sleep for 21 minutes
      nextSampleAt = 21 * 60000;
    }

    if (!is_streaming && state.isDriving) {
      // We may need to refresh the vehicle token, so let's just do it for every streaming start
      console.log("Fetching vehicles...");
      const vehicles = await listVehicles(token);
      vehicle = vehicles[options.vehicleIndex];
      options.vehicle = vehicle;
      console.log("Using vehicle ", vehicle);

      is_streaming = true;
      console.log("Starting streaming ...")
      startStreaming(options, (err) => {
        console.log('websocket error: ' + err);
        is_streaming = false;
      }, onMessage = (message) => {
        const msg = JSON.parse(message);
        if (msg.msg_type === 'data:update') {
          const streamData = {}
          const values = msg.value.split(",");
          streamData['timestamp'] = parseInt(values[0])

          for (let i = 0; i < stream_columns.length; i++) {
            const key = stream_columns_alias[i];
            let value = values[i+1];
            if (key !== "shift_state") {
              value = parseFloat(value);
            }
            streamData[key] = value;
          }

          insertDataPoints(client, streamData, timeseriesNames);
        } else {
          console.log(msg);
        }
      });
    }
  } catch (e) {
    console.log("Error sampling: ", e)
    state = {};
    options.token = undefined;
  }

  setTimeout(() => sample(options, state), nextSampleAt);
}

const token = process.env.TESLA_TOKEN !== undefined ? process.env.TESLA_TOKEN : argv.token;
const username = process.env.TESLA_USERNAME !== undefined ? process.env.TESLA_USERNAME : argv.username;
const password = process.env.TESLA_PASSWORD !== undefined ? process.env.TESLA_PASSWORD : argv.password;
const project = process.env.COGNITE_PROJECT !== undefined ? process.env.COGNITE_PROJECT : argv.project;
const apiKey = process.env.COGNITE_API_KEY !== undefined ? process.env.COGNITE_API_KEY : argv.apikey;
const vehicleIndex = process.env.VEHICLE_INDEX !== undefined ? process.env.VEHICLE_INDEX : argv.vehicleindex;

if (argv.gettoken) {
  getToken(username, password).then((token) => {
    console.log(token);
  });
} else if (argv.listvehicles) {
  listVehicles(token).then((vehicles) => {
    console.log(vehicles);
  });
} else {
  const client = new CogniteClient({ appId: 'TeslaExtractor' });
  client.loginWithApiKey({
    project,
    apiKey,
  });

  const timeseries = client.timeseries.list({rootAssetIds: [5410924510734447], limit: 1000}).autoPagingToArray({limit: -1}).then(timeseries => {
    const timeseriesNames = timeseries.map( ts => ts.name);
    options = {
      username,
      password,
      token, 
      client, 
      timeseriesNames, 
      vehicleIndex, 
    }
    sample(options, {});
  });
}