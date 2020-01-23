# Cognite Tesla extractor
Extract real-time data from your Tesla into Cognite Data Fusion.

## Create asset hierarchy
You need to have the Cognite SDK installed. To create the asset hierarchy and corresponding time series, run 

`python create_cdf_resources.py`

## Run the extractor
If you have one car, you can start sampling by running this command (you can also specify input variables as environment variables where `--vehicleindex` is specified as `VEHICLE_INDEX`)

```
node index.js \
  --username $TESLA_USERNAME \
  --password $TESLA_PASSWORD \
  --project $COGNITE_PROJECT \ 
  --apikey $COGNITE_API_KEY \
  --vehicleindex
```

If you have multiple cars, list the vehicles with
```
node index.js \
  --username $TESLA_USERNAME \
  --password $TESLA_PASSWORD \
  --listvehicles
```

to find the index of the car you want to sample for.