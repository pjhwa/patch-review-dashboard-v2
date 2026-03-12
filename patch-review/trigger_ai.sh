#!/bin/bash
curl -X POST http://localhost:3001/api/pipeline/execute -H " Content-Type: application/json\ -d '{\category\: \os\}'
