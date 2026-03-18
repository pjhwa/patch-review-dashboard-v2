import os
import glob
import json

base_dir = '/home/citec/.openclaw/workspace/skills/patch-review/os/linux/redhat/redhat_data'
files = glob.glob(os.path.join(base_dir, '*.json'))

severities = {}
for f in files:
    try:
        with open(f, 'r') as jf:
            data = json.load(jf)
            if not isinstance(data, dict): continue
            sev = data.get('severity', '')
            if not sev: sev = 'EMPTY_OR_MISSING'
            severities[sev] = severities.get(sev, 0) + 1
    except:
        pass

print('Red Hat JSON Severities:')
for k, v in severities.items():
    print(f'{k}: {v}')
