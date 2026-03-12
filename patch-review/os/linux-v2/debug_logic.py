import json
import glob
import re

def format_redhat_os_versions(affected_products):
    if not affected_products: return ""
    versions = set()
    sap_versions = set()
    for prod in affected_products:
        m = re.search(r'\(v\.([\d.]+)\)', prod)
        ver = m.group(1) if m else None
        if not ver: continue
        
        if 'SAP' in prod or 'E4S' in prod:
            sap_versions.add(ver)
        else:
            versions.add(ver)
            
    extracted = []
    has_generic_8 = any(v == '8' for v in versions)
    has_generic_9 = any(v == '9' for v in versions)
    has_generic_10 = any(v == '10' for v in versions)
    
    if has_generic_8: extracted.append("RHEL 8")
    if has_generic_9: extracted.append("RHEL 9")
    if has_generic_10: extracted.append("RHEL 10")
    
    for sv in sap_versions:
        major = sv.split('.')[0]
        if (major == '8' and has_generic_8) or (major == '9' and has_generic_9) or (major == '10' and has_generic_10):
            continue
        extracted.append(f"RHEL for SAP Solution {sv}")
        
    for v in versions:
        if v not in ['8', '9', '10']:
            major = v.split('.')[0]
            if (major == '8' and has_generic_8) or (major == '9' and has_generic_9) or (major == '10' and has_generic_10):
                continue
            extracted.append(f"RHEL {v}")
            
    return ", ".join(sorted(set(extracted)))

for f in glob.glob("/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/batch_data/*.json"):
    with open(f, 'r') as jf:
        data = json.load(jf)
        if not isinstance(data, dict): continue
        patch_id = data.get('id', '')
        vendor = data.get('vendor', '')
        
        if vendor == "Red Hat":
            affected = data.get('affected_products', [])
            res = format_redhat_os_versions(affected)
            if res:
                pass # print(f"{patch_id} -> {res}")
        elif vendor == "Oracle":
            synopsis = data.get('synopsis', '')
            # [El-errata] ELBA-2026-2413 Oracle Linux 8 microcode_ctl bug fix and enhancement update
            m = re.search(r'Oracle Linux \d+ ([\w-]+)\s', synopsis)
            if m:
                pass # print(f"{patch_id} -> Comp: {m.group(1)}")
            if patch_id in ['ELBA-2026-2413', 'ELBA-2026-1352', 'ELSA-2026-3361']:
                print(f"ORACLE {patch_id} => Comp: {m.group(1) if m else 'NOT FOUND'}, Synopsis: {synopsis}")
