import json
import glob
import sys
import os

sys.path.append('/home/citec/.openclaw/workspace/skills/patch-review/os/linux')
from patch_preprocessing import extract_redhat_content

files = sorted(glob.glob('/home/citec/.openclaw/workspace/skills/patch-review/os/linux/batch_data/RHSA-*.json'))[-20:]
for f in files:
    try:
        data = json.load(open(f))
        ft = data.get('full_text', '')
        ex = extract_redhat_content(ft)
        print(f"{data.get('id')} - len(orig): {len(ft)}, len(extracted): {len(ex)}")
    except Exception as e:
        pass
