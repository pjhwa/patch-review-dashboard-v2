PID=$(sudo netstat -tlnp | grep 3001 | awk '{print $7}' | cut -d'/' -f1)
if [ ! -z "$PID" ]; then sudo kill -9 $PID; fi
sleep 2
cd ~/patch-review-dashboard-v2 && source ~/.nvm/nvm.sh && npm run build && nohup npm run start -- -p 3001 > server_output.log 2>&1 &
