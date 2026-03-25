import re
import csv
import os
import json
from datetime import datetime, timedelta
import sqlite3
import uuid
import glob
import argparse

# NOTE: This script replaces 'perform_llm_review_simulation.py'. 
# It does NOT perform the review. It performs the mechanical PRE-PROCESSING 
# (Collection, Pruning, Aggregation) to prepare a clean dataset for the AI Agent (LLM) to review.

JSON_DIRS_ALL = {
    "redhat": [os.path.join("redhat", "redhat_data")],
    "oracle": [os.path.join("oracle", "oracle_data")],
    "ubuntu": [os.path.join("ubuntu", "ubuntu_data")],
}
JSON_DIRS = [os.path.join("redhat", "redhat_data"), os.path.join("oracle", "oracle_data"), os.path.join("ubuntu", "ubuntu_data")]
OUTPUT_FILE = "patches_for_llm_review.json"

# --- CONFIGURATION: PRUNING RULES ---
# STRICT WHITELIST: ONLY components capable of causing "System Critical" failures.
SYSTEM_CORE_COMPONENTS = [
    # 1. Kernel & Hardware Interaction
    "kernel", "linux-image", "microcode", "microcode_ctl", "linux-firmware", 
    "shim", "grub", "grub2", "efibootmgr", "mokutil",
    
    # 2. Storage & Filesystem
    "lvm2", "device-mapper", "multipath-tools", "kpartx", 
    "e2fsprogs", "xfsprogs", "dosfstools", "nfs-utils", "cifs-utils",
    "iscsi-initiator-utils", "open-iscsi", "smartmontools",
    
    # 3. Cluster & High Availability
    "pacemaker", "corosync", "pcs", "fence-agents", "resource-agents", "keepalived",
    
    # 4. Critical Networking
    "networkmanager", "firewalld", "iptables", "nftables", 
    "bind", "bind-utils", "dhcp", "dhclient",
    
    # 5. Core System Services
    "systemd", "udev", "initscripts", "glibc", 
    "dbus", "audit",
    
    # 6. Critical Security
    "openssl", "gnutls", "nss", "ca-certificates",
    "openssh", "sshd", "sudo", "pam", "polkit",
    "selinux-policy", "libselinux",
    
    # 7. Virtualization Infrastructure
    "libvirt", "qemu-kvm", "qemu", "kvm",
    "docker", "podman", "runc", "containerd", "kubernetes", "kubelet"
]

# Ubuntu LTS versions whose Standard Security Maintenance has EXPIRED (as of 2026-02-19).
# Reference: https://ubuntu.com/about/release-cycle
# 14.04 LTS: expired 2019-04 | 16.04 LTS: expired 2021-04 | 18.04 LTS: expired 2023-04 | 20.04 LTS: expired 2025-05
UBUNTU_EOL_LTS_VERSIONS = {"14.04 LTS", "16.04 LTS", "18.04 LTS", "20.04 LTS"}

# Suffix map for Ubuntu LTS versions (used to generate per-OS-version IDs, e.g. USN-8060-1-2204)
LTS_SUFFIX_MAP = {
    "22.04 LTS": "2204",
    "24.04 LTS": "2404",
    "26.04 LTS": "2604",
}

EXCLUDED_PACKAGES_EXPLICIT = [
    "firefox", "thunderbird", "libreoffice", "evolution", 
    "gimp", "inkscape", "cups", "avahi", "bluez", "pulseaudio", "pipewire",
    "gnome", "kde", "xorg", "wayland", "mesa", "webkit",
    "python-urllib3", "python-requests", "nodejs", "ruby", "perl", "php",
    "tar", "gzip", "zip", "unzip", "vim", "nano", "emacs",
    "compiz", "alsa", "sound"
]

def parse_date(date_str):
    """Normalizes date string to YYYY-MM-DD or YYYY-MM"""
    if not date_str: return "Unknown"
    date_str = date_str.strip()
    
    # Format: "2026-February" -> "2026-02"
    match = re.match(r"(\d{4})-(January|February|March|April|May|June|July|August|September|October|November|December)", date_str, re.IGNORECASE)
    if match:
        year = match.group(1)
        month_name = match.group(2)
        try:
            dt = datetime.strptime(month_name, "%B")
            return f"{year}-{dt.month:02d}"
        except: pass

    # Format: "Thu, 12 Feb 2026..."
    try:
        # Simple extraction of YYYY-MM-DD if ISO format exists
        if "T" in date_str: return date_str[:10]
        # Or simplistic parse if standard format failed
    except: pass
    
    return date_str[:10] # Fallback

def extract_oracle_version(text):
    """Extracts Oracle Linux version (6, 7, 8, 9, 10) from text"""
    # 1. Explicit "Oracle Linux X"
    match = re.search(r"Oracle Linux (\d+)", text, re.IGNORECASE)
    if match: return f"ol{match.group(1)}"
    
    # 2. Rpm tags like "el9", "el10", "el8" in filenames
    match_el = re.search(r"\.el(\d+)uek", text, re.IGNORECASE)
    if match_el: return f"ol{match_el.group(1)}"
    
    # 3. Simple text indicators
    if "el8" in text.lower(): return "ol8"
    if "el9" in text.lower(): return "ol9"
    if "el7" in text.lower(): return "ol7"
    if "el10" in text.lower() or "ol10" in text.lower(): return "ol10"
    
    return ""

def extract_redhat_date(text):
    """Extracts 'Issued: YYYY-MM-DD' from Red Hat full text"""
    # Try English "Issued: YYYY-MM-DD"
    match = re.search(r"Issued:\s*(\d{4}-\d{2}-\d{2})", text)
    if match: return match.group(1)

    # Try Japanese "発行日: YYYY-MM-DD"
    match = re.search(r"発行日:\s*(\d{4}-\d{2}-\d{2})", text)
    if match: return match.group(1)
    
    return ""

def extract_redhat_content(text):
    """Clean Red Hat boilerplate and extract Description/Topic/Fixes"""
    return text[:4000].strip()

def format_redhat_os_versions(affected_products):
    if not affected_products: return ""
    versions = set()
    sap_versions = set()
    for prod in affected_products:
        m = re.search(r'\(v\.([\d.]+)\)', prod)
        if m:
            ver = m.group(1)
        else:
            m_base = re.search(r'Red Hat Enterprise Linux.*?\b([89]|10)(?:\.\d+)?\b', prod)
            if m_base:
                ver = m_base.group(1)
            else:
                continue
        
        if 'SAP' in prod or 'E4S' in prod:
            sap_versions.add(ver)
        elif 'EUS' in prod or 'Extended Update Support' in prod or ' AUS ' in prod or '- AUS' in prod or 'Advanced Mission Critical' in prod or 'TUS ' in prod or 'Telco' in prod or 'Advanced Update Support' in prod:
            sap_versions.add(f"EUS {ver}")
        else:
            versions.add(ver.split('.')[0])
            
    extracted = []
    has_generic_8 = any(v == '8' for v in versions)
    has_generic_9 = any(v == '9' for v in versions)
    has_generic_10 = any(v == '10' for v in versions)
    
    if has_generic_8: extracted.append("RHEL 8")
    if has_generic_9: extracted.append("RHEL 9")
    if has_generic_10: extracted.append("RHEL 10")
    
    for sv in sap_versions:
        major = sv.split('.')[-1] if ' ' in sv else sv.split('.')[0] 
        base_major = sv.split(' ')[-1].split('.')[0] if ' ' in sv else major
        if (base_major == '8' and has_generic_8) or (base_major == '9' and has_generic_9) or (base_major == '10' and has_generic_10):
            continue
        prefix = "RHEL EUS" if "EUS" in sv else "RHEL for SAP Solution"
        ver_num = sv.split(' ')[-1] if "EUS" in sv else sv
        extracted.append(f"{prefix} {ver_num}")
        
    for v in versions:
        if v not in ['8', '9', '10']:
            major = v.split('.')[0]
            if (major == '8' and has_generic_8) or (major == '9' and has_generic_9) or (major == '10' and has_generic_10):
                continue
            extracted.append(f"RHEL {v}")
            
    if not extracted:
        return "RHEL"
        
    return ", ".join(sorted(set(extracted)))

def extract_diff_content(text, vendor):
    """Extracts relevant 'diff' content (changes) from full text"""
    lower_text = text.lower()
    
    if vendor == "Oracle":
        # Extract "Description of changes" section
        marker = "description of changes:"
        idx = lower_text.find(marker)
        if idx != -1:
            return text[idx+len(marker):].strip()
            
    elif vendor == "Ubuntu":
        # Extract "Details" section
        marker = "details"
        idx = lower_text.find(marker)
        if idx != -1:
            # Try to stop at next section (e.g. "Update instructions")
            end_marker = "update instructions"
            end_idx = lower_text.find(end_marker)
            if end_idx != -1:
                return text[idx+len(marker):end_idx].strip()
            return text[idx+len(marker):].strip()

    elif vendor == "Red Hat":
        return extract_redhat_content(text)
            
    # Default: Return cleanedsummary/synopsis
    return text[:500] + "..." if len(text) > 500 else text

def extract_base_component(pkgs):
    arch_exts = ['.x86_64', '.aarch64', '.src', '.noarch', '.i686', '.s390x', '.ppc64le']
    names = []
    for pkg in pkgs:
        stripped = str(pkg)
        for ext in arch_exts:
            if stripped.endswith(ext):
                stripped = stripped[:-len(ext)]
                break
        
        m = re.match(r'^([a-zA-Z0-9_+-]+?)-([\d][a-zA-Z0-9_+.:-]+)$', stripped)
        if m:
            names.append(m.group(1))
        else:
            m2 = re.match(r'^([a-zA-Z0-9_+-]+?)[-_]([\d][a-zA-Z0-9_+.:~-]+)$', stripped)
            if m2:
                names.append(m2.group(1))
    
    if not names:
        return None
        
    names = sorted(list(set(names)))
    names.sort(key=len)
    
    for pkg in pkgs:
        if str(pkg).endswith('.src'):
            stripped = str(pkg)[:-4]
            m = re.match(r'^([a-zA-Z0-9_+-]+?)-([\d][a-zA-Z0-9_+.:-]+)$', stripped)
            if m:
                return m.group(1)
                
    return names[0]

def get_component_name(vendor, title, summary, full_text, pkgs=None):
    if pkgs and isinstance(pkgs, list) and len(pkgs) > 0:
        base_comp = extract_base_component(pkgs)
        if base_comp:
            if vendor == "Oracle" and "uek" in base_comp:
                version_match = re.search(r'(\d+\.\d+)\.\d+', title + " " + summary)
                if not version_match:
                    version_match = re.search(r'(\d+\.\d+)\.\d+', full_text)
                kern_series = f"-v{version_match.group(1)}" if version_match else ""
                return f"kernel-uek{kern_series}"
            
            for core in SYSTEM_CORE_COMPONENTS:
                if core == base_comp or base_comp.startswith(core + "-"):
                    return core
            return base_comp
    text = (title + " " + summary + " " + full_text).lower()
    text_primary = (title + " " + summary).lower()
    
    # 1. Oracle Special Case: Exact Parsing from Synopsis
    if vendor == "Oracle":
        m = re.search(r'Oracle Linux \d+ ([\w-]+)\s', title + " " + summary)
        if m:
            comp = m.group(1)
            if "Unbreakable" in comp or "kernel" in comp:
                comp = "kernel-uek"
            elif "microcode" in comp:
                comp = "microcode_ctl"
            return comp
            
        if "uek" in text_primary or "unbreakable enterprise kernel" in text_primary:
            comp = "kernel-uek"
            
            # Extract Major.Minor version for stream splitting (e.g. 5.15, 6.12)
            version_match = re.search(r'(\d+\.\d+)\.\d+', text_primary)
            if not version_match:
                version_match = re.search(r'(\d+\.\d+)\.\d+', text)
            kern_series = f"-v{version_match.group(1)}" if version_match else ""
            
            ol_ver = extract_oracle_version(text_primary)
            if not ol_ver: ol_ver = extract_oracle_version(text)
            ver_suffix = f"-{ol_ver}" if ol_ver else ""
            
            return f"{comp}{kern_series}{ver_suffix}"
            
        # If it's not UEK, fall through to the Ubuntu/RHEL heuristics (Rule 2)
        # We don't return 'other' immediately anymore.
    
    # 2. Ubuntu/RHEL Heuristics
    # Search primary text first to avoid false positives from body
    for core in SYSTEM_CORE_COMPONENTS:
        if re.search(fr'\b{re.escape(core)}\b', text_primary):
            return core
            
    for core in SYSTEM_CORE_COMPONENTS:
        if re.search(fr'\b{re.escape(core)}\b', text):
            return core
            
    m = re.search(r'([a-z0-9]+(-[a-z0-9]+)*)-\d+\.\d+', text_primary)
    if not m:
        m = re.search(r'([a-z0-9]+(-[a-z0-9]+)*)-\d+\.\d+', text)
    if m: 
        name = m.group(1)
        for core in SYSTEM_CORE_COMPONENTS:
            if core == name or (name.startswith(core + "-")):
                return core
        return name
        
    return "other"

def get_best_rpm_match(pkgs, comp):
    arch_exts = ['.x86_64', '.aarch64', '.src', '.noarch', '.i686', '.s390x', '.ppc64le']
    best_ver = ""
    # pass 1: exact match
    for pkg in pkgs:
        stripped = pkg
        for ext in arch_exts:
            if stripped.endswith(ext):
                stripped = stripped[:-len(ext)]
                break
        
        m = re.match(r'^([a-zA-Z0-9_+-]+?)-([\d][a-zA-Z0-9_+.:-]+)$', stripped)
        if m:
            name, ver = m.group(1), m.group(2)
            if name == comp or (comp.startswith("kernel-uek") and name == "kernel-uek"):
                return f"{name}-{ver}"
    
    # pass 2: prefix match
    for pkg in pkgs:
        stripped = pkg
        for ext in arch_exts:
            if stripped.endswith(ext):
                stripped = stripped[:-len(ext)]
                break
                
        m = re.match(r'^([a-zA-Z0-9_+-]+?)-([\d][a-zA-Z0-9_+.:-]+)$', stripped)
        if m:
            name, ver = m.group(1), m.group(2)
            if name.startswith(comp) or comp in name:
                return f"{name}-{ver}"
                
    # pass 3: just return the first one stripped
    if pkgs:
        stripped = str(pkgs[0])
        for ext in arch_exts:
            if stripped.endswith(ext):
                stripped = stripped[:-len(ext)]
                break
        m = re.match(r'^([a-zA-Z0-9_+-]+?)-([\d][a-zA-Z0-9_+.:-]+)$', stripped)
        if m:
            return f"{m.group(1)}-{m.group(2)}"
        return stripped
    return best_ver

def is_system_critical(vendor, component, text):
    comp = component.lower()

    if "ovirt 4.5" in text.lower(): return False

    # Rule 2: Strict Whitelist (RHEL/Ubuntu/Oracle)
    for bad in EXCLUDED_PACKAGES_EXPLICIT:
        if bad == comp or (f"{bad}-" in comp): return False

    for core in SYSTEM_CORE_COMPONENTS:
        if core == comp: return True
        if comp.startswith(f"{core}-"): return True

    if "kernel" in comp and "texlive" not in comp: return True
    return False

# Kernel-related component prefixes for dual-window filtering
KERNEL_RELATED_PREFIXES = ["kernel", "linux-image", "linux-firmware", "microcode"]

def is_kernel_related(component):
    """Returns True if the component is kernel or kernel-related (subject to dual-window rules)."""
    comp_lower = component.lower()
    for prefix in KERNEL_RELATED_PREFIXES:
        if comp_lower == prefix or comp_lower.startswith(prefix + "-") or comp_lower.startswith(prefix + "_"):
            return True
    return False

EMPTY_SEVERITY_VALS_FOR_INFERENCE = {"", "none", "n/a", "unknown", "null"}

def infer_severity_from_text(text):
    """
    Keyword-based severity inference for vendors without formal severity labels (Ubuntu, Oracle).
    Returns inferred severity string ('Critical', 'Important', 'Moderate', 'Low') or 'Unknown'.
    Applied post-filtering so it does not affect drop logic.
    """
    t = (text or '').lower()
    if re.search(
        r'remote code execution|(?<!\w)rce(?!\w)|unauthenticated remote|zero.day|zero day'
        r'|container escape|privilege escalation|elevation of privilege|authentication bypass'
        r'|out.of.bounds write|heap overflow|use.after.free|arbitrary code execution'
        r'|gain.*root|root.*privilege|hypervisor escape',
        t
    ):
        return 'Critical'
    if re.search(
        r'denial.of.service|memory corruption|buffer overflow|local attacker.*privilege'
        r'|privilege.*local attacker|unauthorized access|hypervisor|virtual machine escape'
        r'|arbitrary.*execut|execut.*arbitrary|code.*execut|execut.*code',
        t
    ):
        return 'Important'
    if re.search(r'\bmoderate\b|\bmedium\b', t):
        return 'Moderate'
    if re.search(r'\blow\b|\binformational\b', t):
        return 'Low'
    return 'Unknown'

def is_critical_severity(severity):
    """Returns True if severity is Critical."""
    if not severity:
        return False
    return "critical" in severity.lower()

def is_critical_or_important_severity(severity):
    """Returns True if severity is Critical or Important."""
    if not severity:
        return False
    sev_lower = severity.lower()
    return "critical" in sev_lower or "important" in sev_lower

def is_severity_ok_for_window(vendor, severity, window_type):
    """
    Vendor-aware severity threshold check for kernel dual-window filtering.

    RedHat always assigns severity (Critical/Important/Moderate/Low) → require explicit threshold.
    Oracle (ELSA/ELBA) and Ubuntu (USN) frequently omit severity, especially for kernel advisories
    (UEK errata, USN notices without formal severity ratings).
    For these vendors, absent severity means 'Unknown' — not Low — so pass through to AI review.
    """
    # Treat string "None", "none", "n/a", "unknown" as absent severity
    EMPTY_SEVERITY_VALS = {"", "none", "n/a", "unknown", "null"}
    if not severity or severity.strip().lower() in EMPTY_SEVERITY_VALS:
        # Oracle/Ubuntu: no severity ≠ low severity — AI will assess from full_text and CVEs
        return vendor in ("Oracle", "Ubuntu")
    if window_type == 'early':
        return is_critical_or_important_severity(severity)
    else:
        return is_critical_severity(severity)

def extract_ubuntu_pkg_version(packages, component, lts_ver, all_lts_versions):
    """Extract the specific package version for a given Ubuntu LTS version.

    Strategy 1 (backport): packages backported to an older LTS carry a version suffix
    like '~22.04.1'. If a package matching the component has that suffix, use it.

    Strategy 2 (native): packages without any '~XX.XX.' suffix are 'native' to their
    release. When a USN covers multiple releases, each release typically ships its own
    version of the package (e.g. binutils 2.38 for 22.04, 2.42 for 24.04). We sort the
    native candidates by version string and map them to the sorted LTS list so that the
    older LTS gets the lower version.
    """
    ver_tag = lts_ver.replace(" LTS", "")       # "22.04"
    backport_marker = f"~{ver_tag}."             # "~22.04."
    comp_lower = component.lower()

    # Pass 1: explicit backport suffix
    for pkg in packages:
        pkg_str = str(pkg)
        if backport_marker not in pkg_str:
            continue
        pkg_lower = pkg_str.lower()
        if pkg_lower.startswith("linux-image") or pkg_lower.startswith(comp_lower):
            m = re.search(r'-(\d[\w.+:~-]*)$', pkg_str)
            if m:
                return m.group(1)

    # Pass 2: native packages (no '~' in version string)
    native_candidates = []
    for pkg in packages:
        pkg_str = str(pkg)
        if "~" in pkg_str:
            continue
        pkg_lower = pkg_str.lower()
        if pkg_lower.startswith("linux-image") or pkg_lower.startswith(comp_lower):
            m = re.search(r'-(\d[\w.+:~-]*)$', pkg_str)
            if m:
                native_candidates.append((pkg_str, m.group(1)))

    if native_candidates:
        native_candidates.sort()  # lower version first → older Ubuntu release
        sorted_lts = sorted(all_lts_versions)
        try:
            idx = sorted_lts.index(lts_ver)
            return native_candidates[min(idx, len(native_candidates) - 1)][1]
        except (ValueError, IndexError):
            return native_candidates[0][1]

    return ""

def preprocess_patches():
    parser = argparse.ArgumentParser(description="Pre-process collected patches for AI review.")
    parser.add_argument('--days', type=int, default=180, help="Total lookback period in days (default: 180). Kernel patches from the first half (early window) are subject to stricter filtering.")
    parser.add_argument('--vendor', type=str, default=None,
                        help="Vendor to process: 'redhat', 'oracle', or 'ubuntu'. If not set, processes all vendors.")
    args = parser.parse_args()

    # Determine which directories and output file to use based on vendor argument
    vendor_arg = args.vendor.lower() if args.vendor else None
    if vendor_arg and vendor_arg in JSON_DIRS_ALL:
        active_dirs = JSON_DIRS_ALL[vendor_arg]
        output_file = f"patches_for_llm_review_{vendor_arg}.json"
        print(f"[PREPROCESS] Vendor filter: {vendor_arg} -> dirs: {active_dirs}, output: {output_file}")
    else:
        active_dirs = JSON_DIRS
        output_file = OUTPUT_FILE

    now = datetime.now()
    cutoff_early = now - timedelta(days=args.days)   # 6 months ago (early window start)
    cutoff_recent = now - timedelta(days=90)          # 3 months ago (recent window start)
    print(f"[PREPROCESS] Kernel dual-window:")
    print(f"  Early window ({cutoff_early.strftime('%Y-%m-%d')}~{cutoff_recent.strftime('%Y-%m-%d')}): Critical/Important only — most recent per (vendor, component, OS version)")
    print(f"  Recent window ({cutoff_recent.strftime('%Y-%m-%d')}~{now.strftime('%Y-%m-%d')}): Critical only — all Critical patches")
    print(f"[PREPROCESS] Non-kernel patches: recent window only ({cutoff_recent.strftime('%Y-%m-%d')} ~ now)")

    print("Loading data from directories...")

    raw_list = []
    dropped_audit_log = []

    # --- Step 1: Ingest JSONs directly ---
    json_files = []
    for d in active_dirs:
        if os.path.isdir(d):
            json_files.extend(sorted(glob.glob(os.path.join(d, "*.json"))))
    print(f"Found {len(json_files)} JSON files.")

    for json_path in json_files:
        try:
            with open(json_path, 'r', encoding='utf-8') as jf:
                data = json.load(jf)
            
            # Skip non-dict entries (e.g., collection_failures.json which is a list)
            if not isinstance(data, dict):
                continue
                
            vendor = data.get('vendor', 'Unknown')
            if 'Ubuntu' in vendor:
                vendor = 'Ubuntu'
            patch_id = data.get('id', os.path.basename(json_path).replace('.json', ''))
            
            # Normalization
            date_raw = data.get('pubDate', data.get('dateStr', ''))
            date_str = parse_date(date_raw)
            
            title = data.get('title', '')
            
            synp = data.get('synopsis', '').strip()
            over = data.get('overview', '').strip()
            desc = data.get('description', '').strip()
            
            # Intelligently combine description text for the UI
            parts = []
            if synp: parts.append(synp)
            if over and over != synp: parts.append(over)
            if desc and desc not in (over, synp): parts.append(desc)
            
            summary = "\n\n".join(parts)
            
            full_text = data.get('full_text', '') 
            severity = data.get('severity', '')
            affected_products = data.get('affected_products', [])
            
            # Content Cleaning (Red Hat)
            if vendor == "Red Hat":
                rh_date = extract_redhat_date(full_text)
                full_text = extract_redhat_content(full_text)
                if rh_date: date_str = rh_date
                if not summary:
                    summary = title # Fallback
            
            # --- DATE WINDOW FILTERING ---
            window_type = 'recent'  # default; updated below if parsed successfully
            try:
                # Basic parsing try if formatting matches YYYY-MM-DD or YYYY-MM
                if len(date_str) == 10:
                    pub_dt = datetime.strptime(date_str, "%Y-%m-%d")
                elif len(date_str) == 7:
                    pub_dt = datetime.strptime(date_str, "%Y-%m")
                else:
                    pub_dt = datetime.now() # Fallback for malformed

                # Check timeframe: reject anything older than the early cutoff (6 months)
                if pub_dt < cutoff_early:
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Outside Target Window', 'Details': f"Date: {date_str} (Cutoff: {cutoff_early.strftime('%Y-%m-%d')})" })
                    continue

                # Classify into early (6m~3m) or recent (3m~now)
                window_type = 'recent' if pub_dt >= cutoff_recent else 'early'
            except Exception as e:
                # If we absolutely can't parse it, we give it the benefit of the doubt (treat as recent)
                pass
                
            # --- EXCLUSION FILTERS ---
            # 1. Garbage Data (Empty Content or Known Bad ID)
            if "openshift" in title.lower() or "openshift" in summary.lower():
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Garbage Data', 'Details': 'Contains "openshift"' })
                continue
            if "kubernetes" in title.lower() or "kubernetes" in summary.lower():
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Garbage Data', 'Details': 'Contains "kubernetes"' })
                continue
            if "extended lifecycle" in title.lower() or "extended lifecycle" in summary.lower() or "extended lifecycle" in full_text.lower()[:500]:
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Garbage Data', 'Details': 'Contains "extended lifecycle"' })
                continue
            if "rhel 7" in title.lower() and vendor == "Red Hat":
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Garbage Data', 'Details': 'Matches "rhel 7" for Red Hat' })
                continue
            if (len(full_text) < 50 and vendor == "Red Hat") or patch_id in ["RHSA-2026:2664", "RHSA-2025:23032", "RHSA-2025:23030"]:
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Garbage Data', 'Details': 'Text len < 50 or Blacklisted ID' })
                continue
            
            # 2. Granular Severity Rule (Keep Critical/Important/None, Drop Moderate/Low)
            if severity:
                sev_lower = severity.lower()
                if "moderate" in sev_lower or "low" in sev_lower:
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Severity Under Threshold', 'Details': f"Severity: {severity}" })
                    continue

            # 3. Red Hat Specific Product Validation
            if vendor == "Red Hat":
                if not isinstance(affected_products, list) or len(affected_products) == 0:
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Missing Affected Products', 'Details': 'Empty or missing list' })
                    continue
                is_rhba = "RHBA" in patch_id
                is_rhsa = "RHSA" in patch_id
                has_valid_product = False
                
                rhba_patterns = [
                    r'Red Hat Enterprise Linux for x86_64 (?:8|9|10)(?:\.\d+)? x86_64',
                    r'Red Hat Enterprise Linux High Availability for x86_64 (?:8|9|10)(?:\.\d+)? x86_64',
                    r'Red Hat Enterprise Linux for x86_64 - Update Services for SAP Solutions (?:8|9|10)(?:\.\d+)? x86_64'
                ]
                
                rhsa_patterns = [
                    r'Red Hat Enterprise Linux BaseOS \(v\.\s?(?:8|9|10)(?:\.\d+)?\)',
                    r'Red Hat Enterprise Linux AppStream \(v\.\s?(?:8|9|10)(?:\.\d+)?\)',
                    r'Red Hat Enterprise Linux High\s?Availability \(v\.\s?(?:8|9|10)(?:\.\d+)?\)'
                ]
                
                for prod in affected_products:
                    matched = False
                    if is_rhba:
                        for pat in rhba_patterns:
                            if re.search(pat, prod):
                                matched = True
                                break
                    elif is_rhsa:
                        for pat in rhsa_patterns:
                            if re.search(pat, prod):
                                matched = True
                                break
                    else:
                        for pat in rhba_patterns + rhsa_patterns:
                            if re.search(pat, prod):
                                matched = True
                                break
                    
                    if matched:
                        has_valid_product = True
                        break
                        
                if not has_valid_product:
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Invalid Product Variant', 'Details': f"Did not match target RHEL streams. Products: {affected_products}" })
                    continue
                
            # 3.1. Oracle Architecture Filtering
            if vendor == "Oracle":
                arch_valid = False
                if isinstance(affected_products, list):
                    for prod in affected_products:
                        if "x86_64" in prod.lower():
                            arch_valid = True
                            break
                if not arch_valid and "x86_64" in full_text.lower():
                    arch_valid = True
                    
                if not arch_valid:
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Architecture Mismatch', 'Details': 'Not x86_64' })
                    continue
                
            # 4. Ubuntu Variant Exclusions
            if vendor == "Ubuntu" and "kernel" in title.lower():
                if "linux - linux kernel" not in full_text.lower():
                    dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'Ubuntu Variant Exclusion', 'Details': 'Not standard linux-kernel (likely raspi, aws, oem, etc.)' })
                    continue
                
            # 5. User Blacklist (kernel-rt)
            if "real time" in title.lower() or "kernel-rt" in title.lower() or "kernel-rt" in summary.lower():
                dropped_audit_log.append({ 'Patch ID': patch_id, 'Vendor': vendor, 'Drop Reason': 'User Blacklist', 'Details': 'kernel-rt / Real Time' })
                continue
            
            component = get_component_name(vendor, title, summary, full_text, data.get("packages", []))
            
            specific_ver = ""
            if vendor == "Ubuntu" and isinstance(data.get("packages"), list) and data["packages"]:
                for pkg in data["packages"]:
                    pkg_str = str(pkg)
                    if pkg_str.startswith(component):
                        m = re.match(fr'{re.escape(component)}[-_](.+)', pkg_str)
                        if m:
                            specific_ver = m.group(1)
                            break
                if not specific_ver:
                    specific_ver = str(data["packages"][0])

            if not specific_ver and vendor == "Red Hat":
                m_title = re.search(r'([\d]+\.[\d]+\.[\d]+)', title)
                if m_title and "Update" in title:
                    specific_ver = f"{component}-{m_title.group(1)}"
                if not specific_ver and "packages" in data and isinstance(data["packages"], list):
                    best = get_best_rpm_match(data["packages"], component)
                    if best: specific_ver = best
                
                
            if not specific_ver and vendor == "Oracle" and "packages" in data and isinstance(data["packages"], list):
                best = get_best_rpm_match(data["packages"], component)
                if best: specific_ver = best
            
            # Extract diff content for history/summary
            diff_content = extract_diff_content(full_text, vendor)
            if not diff_content: diff_content = summary

            # --- DIST VERSION EXTRACTION & SPLITTING ---
            dist_versions = []
            os_version_val = "Unknown"
            
            search_text = ""
            if isinstance(affected_products, list):
                search_text = " ".join([str(p) for p in affected_products])
            elif isinstance(affected_products, str):
                search_text = affected_products

            ubuntu_split_done = False
            if vendor == "Ubuntu":
                # Find all "XX.XX LTS" patterns strictly from affected_products
                lts_matches = re.findall(r"(\d{2}\.\d{2} LTS)", search_text)
                if lts_matches:
                    active_lts = [v for v in sorted(set(lts_matches)) if v not in UBUNTU_EOL_LTS_VERSIONS]
                    dist_versions = active_lts
                    os_version_val = ", ".join(active_lts)
                    if active_lts:
                        ubuntu_pkgs = data.get("packages", [])
                        for lts_ver in active_lts:
                            lts_suffix = LTS_SUFFIX_MAP.get(lts_ver, lts_ver.replace(" LTS", "").replace(".", ""))
                            split_id = f"{patch_id}-{lts_suffix}"
                            split_ver = extract_ubuntu_pkg_version(ubuntu_pkgs, component, lts_ver, active_lts) or specific_ver
                            raw_list.append({
                                'id': split_id,
                                'original_id': patch_id,
                                'vendor': vendor,
                                'dist_version': lts_ver,
                                'os_version': lts_ver,
                                'date': date_str,
                                'component': component,
                                'specific_version': split_ver,
                                'summary': summary,
                                'severity': data.get('severity', ''),
                                'diff_content': diff_content,
                                'full_text': full_text + " " + title,
                                'ref_url': data.get('url', ''),
                                'window_type': window_type,
                            })
                        ubuntu_split_done = True

            elif vendor == "Oracle":
                ol_matches = re.findall(r'Oracle Linux (\d+)', search_text, re.IGNORECASE)
                if ol_matches:
                    ol_vers = sorted(set(ol_matches))
                    os_version_val = ", ".join([f"OL{v}" for v in ol_vers])

            elif vendor == "Red Hat":
                os_version_val = format_redhat_os_versions(data.get('affected_products', []))

            if not ubuntu_split_done:
                raw_list.append({
                    'id': patch_id,
                    'original_id': patch_id,
                    'vendor': vendor,
                    'dist_version': dist_versions[0] if dist_versions else os_version_val,
                    'os_version': os_version_val,
                    'date': date_str,
                    'component': component,
                    'specific_version': specific_ver,
                    'summary': summary,
                    'severity': data.get('severity', ''),
                    'diff_content': diff_content,
                    'full_text': full_text + " " + title,
                    'ref_url': data.get('url', ''),
                    'window_type': window_type,  # 'recent' (0~90d) or 'early' (90~180d)
                })

        except Exception as e:
            print(f"Error reading {json_path}: {e}")

    print(f"Raw Patches: {len(raw_list)}")

    # --- Step 2: Pruning ---
    pruned_list = []
    for p in raw_list:
        if not is_system_critical(p['vendor'], p['component'], p['full_text']):
            dropped_audit_log.append({ 'Patch ID': p['id'], 'Vendor': p['vendor'], 'Drop Reason': 'Not System Critical', 'Details': f"Component '{p['component']}' is not in the whitelist or matches an explicit blacklist" })
            continue

        # --- Kernel dual-window rules ---
        if is_kernel_related(p['component']):
            if p['window_type'] == 'early':
                # Early window (6m~3m): Critical or Important severity required
                # Oracle/Ubuntu: absent severity = Unknown (not Low) → pass to AI review
                if not is_severity_ok_for_window(p['vendor'], p['severity'], 'early'):
                    dropped_audit_log.append({ 'Patch ID': p['id'], 'Vendor': p['vendor'], 'Drop Reason': 'Kernel Below Critical/Important', 'Details': f"Kernel component '{p['component']}' severity '{p['severity']}' is below Critical/Important threshold (early window 6m~3m)" })
                    continue
            else:
                # Recent window (0~3m): Critical severity only
                # Oracle/Ubuntu: absent severity = Unknown (not Low) → pass to AI review
                if not is_severity_ok_for_window(p['vendor'], p['severity'], 'recent'):
                    dropped_audit_log.append({ 'Patch ID': p['id'], 'Vendor': p['vendor'], 'Drop Reason': 'Kernel Non-Critical', 'Details': f"Kernel component '{p['component']}' severity '{p['severity']}' is below Critical threshold (recent window 0~3m)" })
                    continue
        else:
            # Non-kernel patches: only the recent window (last 3 months)
            if p['window_type'] == 'early':
                dropped_audit_log.append({ 'Patch ID': p['id'], 'Vendor': p['vendor'], 'Drop Reason': 'Non-Kernel Early Window', 'Details': f"Non-kernel component '{p['component']}' excluded from early window (6m~3m)" })
                continue

        pruned_list.append(p)

    print(f"Pruned Candidates: {len(pruned_list)}")

    # --- Step 3: Aggregation ---
    grouped = {}
    for p in pruned_list:
        # Kernel patches: group by (vendor, component, os_version, window_type)
        #   — keeps early/recent separate AND per-OS-version separate (e.g. RHEL 8 vs RHEL 9)
        # Non-kernel patches: group by (vendor, component) — recent window only
        if is_kernel_related(p['component']):
            key = (p['vendor'], p['component'], p['os_version'], p['window_type'])
        else:
            key = (p['vendor'], p['component'])
        if key not in grouped: grouped[key] = []
        grouped[key].append(p)

    final_candidates = []
    
    for key, group in grouped.items():
        # Sort by ID descending (Latest first)
        group.sort(key=lambda x: x['id'], reverse=True)
        latest = group[0]
        
        # Prepare "History" context for the LLM
        history_context = []
        for old in group[1:]:
            history_context.append({
                'id': old['id'],
                'date': old['date'],
                'diff_summary': old['diff_content'][:800] # Provide diff content, truncated
            })
            
        latest['history'] = history_context
        
        review_note = ""
        if latest['vendor'] == "Oracle": 
            if "kernel-uek" in latest['component']:
                review_note = f"Verify this is UEK kernel ({latest['component']})."
            else:
                review_note = f"Verify this is an Oracle Linux system component ({latest['component']})."
        
        latest['review_instructions'] = f"Analyze this '{latest['component']}' patch ({review_note}). Check for System Hang, Data Loss, Boot Fail, or Critical Security. Merge insights from {len(history_context)} previous patches."
        latest['patch_name_suggestion'] = latest['specific_version'] if latest['specific_version'] else latest['component']
        # Ensure window_type is always present (kernel: 'recent'/'early', non-kernel: 'recent')
        if 'window_type' not in latest:
            latest['window_type'] = key[3] if len(key) == 4 else 'recent'

        # Infer severity for vendors without formal labels (Ubuntu / Oracle)
        if latest['vendor'] in ('Ubuntu', 'Oracle'):
            sev = (latest.get('severity') or '').strip().lower()
            if sev in EMPTY_SEVERITY_VALS_FOR_INFERENCE:
                latest['severity'] = infer_severity_from_text(
                    latest.get('full_text', '') + ' ' + latest.get('summary', '')
                )

        final_candidates.append(latest)

    print(f"Final Candidates for LLM: {len(final_candidates)}")
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(final_candidates, f, indent=2, ensure_ascii=False)

    print(f"Saved review packet to {output_file}")

    # --- Step 3.5: Save Audit Log of Dropped Patches ---
    audit_file = "dropped_patches_audit.csv"
    try:
        if dropped_audit_log:
            # Breakdown by reason
            from collections import Counter
            reasons_count = Counter([log['Drop Reason'] for log in dropped_audit_log])
            
            print(f"\n[AUDIT SUMMARY] Total Dropped Patches: {len(dropped_audit_log)}")
            for reason, count in reasons_count.most_common():
                print(f"  - {reason}: {count}")
            print()
            
            keys = dropped_audit_log[0].keys()
            with open(audit_file, 'w', newline='', encoding='utf-8-sig') as output_file:
                dict_writer = csv.DictWriter(output_file, fieldnames=keys)
                dict_writer.writeheader()
                dict_writer.writerows(dropped_audit_log)
            print(f"[AUDIT] Saved full dropped patches reasons to {audit_file}")
        else:
            print("[AUDIT] No patches were dropped.")
    except Exception as e:
        print(f"[AUDIT ERROR] Failed to write audit log: {e}")

    # --- Step 4: Save to SQLite Database (Incremental: skip already-existing issueIds) ---
    db_path = os.path.expanduser("~/patch-review-dashboard-v2/prisma/patch-review.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path, timeout=20.0)
            cursor = conn.cursor()
            run_id = str(uuid.uuid4())
            inserted = 0
            skipped = 0

            # Delete only the vendor-specific records to avoid wiping other products' data
            if vendor_arg:
                vendor_map = {'redhat': 'Red Hat', 'oracle': 'Oracle', 'ubuntu': 'Ubuntu'}
                vendor_str = vendor_map.get(vendor_arg, vendor_arg)
                cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = ?", (vendor_str,))
            else:
                cursor.execute("DELETE FROM PreprocessedPatch")
            
            for p in final_candidates:
                issue_id = p.get('id', 'Unknown')

                version_str = p.get('specific_version', '') or 'Unknown'
                os_version_str = p.get('os_version', '') or 'Unknown'
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    p.get('vendor', 'Unknown'),
                    issue_id,
                    os_version_str,
                    p.get('component', 'Unknown'),
                    version_str,
                    p.get('severity', ''),
                    p.get('date', ''),
                    p.get('summary', ''),
                    p.get('ref_url', ''),
                    False,
                    run_id
                ))
                inserted += 1

            conn.commit()
            conn.close()
            print(f"[DB SUCCESS] Inserted {inserted} new, skipped {skipped} duplicates into PreprocessedPatch (RunID: {run_id})")
        except Exception as e:
            print(f"[DB ERROR] SQLite insertion failed: {e}")
    else:
        print("[DB WARNING] SQLite database not found. Skipping DB insertion.")

if __name__ == "__main__":
    preprocess_patches()
