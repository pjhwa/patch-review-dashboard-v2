import json
import glob
import re
import sys
from datetime import datetime, timedelta
import pprint

sys.path.append('/home/citec/.openclaw/workspace/skills/patch-review/os/linux')
from patch_preprocessing import SYSTEM_CORE_COMPONENTS, parse_date, extract_oracle_version, get_component_name, UBUNTU_EOL_LTS_VERSIONS

files = glob.glob('/home/citec/.openclaw/workspace/skills/patch-review/os/linux/batch_data/*.json')

stats = {
    'Total': 0,
    'Red Hat': {'Total': 0, 'Drop_Date': 0, 'Drop_Severity': 0, 'Drop_Product': 0, 'Drop_Garbage': 0, 'Drop_NotCore': 0, 'Kept': 0},
    'Oracle': {'Total': 0, 'Drop_Date': 0, 'Drop_Severity': 0, 'Drop_Product': 0, 'Drop_Garbage': 0, 'Drop_NotCore': 0, 'Kept': 0},
    'Ubuntu': {'Total': 0, 'Drop_Date': 0, 'Drop_Severity': 0, 'Drop_Product': 0, 'Drop_Garbage': 0, 'Drop_NotCore': 0, 'Drop_KernelExclude': 0, 'Kept': 0}
}

cutoff_date = datetime.now() - timedelta(days=30)

for f in files:
    try:
        data = json.load(open(f))
        vendor = data.get('vendor', 'Unknown')
        if vendor not in stats: continue
        
        stats['Total'] += 1
        stats[vendor]['Total'] += 1
        
        date_raw = data.get('pubDate', data.get('dateStr', ''))
        date_str = parse_date(date_raw)
        title = data.get('title', '').lower()
        summary = data.get('synopsis', '').lower()
        full_text = data.get('full_text', '')
        severity = data.get('severity', '')
        affected_products = data.get('affected_products', [])
        
        # 1. Date Drop (just an approximation here since parse_date doesn't strictly drop, but the main script does)
        # Assuming the pipeline was run with --days 30:
        try:
            if len(date_str) == 10: pub_dt = datetime.strptime(date_str, "%Y-%m-%d")
            elif len(date_str) == 7: pub_dt = datetime.strptime(date_str, "%Y-%m")
            else: pub_dt = datetime.now()
            if pub_dt < cutoff_date:
                stats[vendor]['Drop_Date'] += 1
                continue
        except Exception:
            pass
            
        # 2. Garbage/Blacklist
        if "openshift" in title or "openshift" in summary or "kubernetes" in title or "kubernetes" in summary or "extended lifecycle" in title or "rhel 7" in title:
            stats[vendor]['Drop_Garbage'] += 1
            continue
            
        # 3. Severity
        if severity:
            sev_lower = severity.lower()
            if "moderate" in sev_lower or "low" in sev_lower:
                stats[vendor]['Drop_Severity'] += 1
                continue
                
        # 4. Product Validation (Red Hat)
        if vendor == "Red Hat" and isinstance(affected_products, list) and len(affected_products) > 0:
            has_valid_product = False
            for prod in affected_products:
                if re.search(r'Red Hat Enterprise Linux.*?(?:[89]|10)\b', prod) or "Update Services for SAP Solutions" in prod:
                    has_valid_product = True
                    break
            if not has_valid_product:
                stats[vendor]['Drop_Product'] += 1
                continue
                
        if vendor == "Ubuntu" and "kernel" in title:
            if "linux - linux kernel" not in full_text.lower():
                stats[vendor]['Drop_KernelExclude'] += 1
                continue
                
        # 5. Core Component Whitelist
        comp = get_component_name(vendor, data.get('title', ''), data.get('synopsis', ''), full_text)
        is_core = False
        for c in SYSTEM_CORE_COMPONENTS:
            if comp == c or comp.startswith(c + "-"):
                is_core = True
                break
        if not is_core:
            stats[vendor]['Drop_NotCore'] += 1
            continue
            
        stats[vendor]['Kept'] += 1
        
    except Exception as e:
        pass

print("\n--- Preprocessing Drop Analysis (30-day Window Simulation) ---")
pprint.pprint(stats)
