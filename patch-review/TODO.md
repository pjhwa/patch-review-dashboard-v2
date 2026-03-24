# TODO

> Last updated: 2026-03-24

## Active Products (13 total)

| Category | Product | Collector | SKILL.md | Status |
|----------|---------|-----------|----------|--------|
| OS/Linux | RHEL | `os/linux/redhat/` | `os/linux/SKILL.md` | Active |
| OS/Linux | Oracle Linux | `os/linux/oracle/` | `os/linux/SKILL.md` | Active |
| OS/Linux | Ubuntu LTS | `os/linux/ubuntu/` | `os/linux/SKILL.md` | Active |
| OS/Windows | Windows Server | `os/windows/` | `os/windows/SKILL.md` | Active |
| Database | MariaDB | `database/mariadb/` | `database/mariadb/SKILL.md` | Active |
| Database | SQL Server | `database/sqlserver/` | `database/sqlserver/SKILL.md` | Active |
| Database | PostgreSQL | `database/pgsql/` | `database/pgsql/SKILL.md` | Active |
| Database | MySQL Community | `database/mysql/` | `database/mysql/SKILL.md` | Active |
| Storage | Ceph | `storage/ceph/` | `storage/ceph/SKILL.md` | Active |
| Virtualization | VMware vSphere | `virtualization/vsphere/` | `virtualization/vsphere/SKILL.md` | Active |
| Middleware | JBoss EAP | `middleware/jboss_eap/` | `middleware/jboss_eap/SKILL.md` | Active |
| Middleware | Apache Tomcat | `middleware/tomcat/` | `middleware/tomcat/SKILL.md` | Active |
| Middleware | WildFly | `middleware/wildfly/` | `middleware/wildfly/SKILL.md` | Active |

## Planned (Not Yet Implemented)

- [ ] **Network**: Cisco IOS-XE, NX-OS / F5 BIG-IP / Fortinet FortiOS
- [ ] **Storage (extended)**: Dell EMC PowerStore/PowerMAX, NetApp ONTAP, Hitachi VSP
- [ ] **Virtualization (extended)**: Citrix Hypervisor
- [ ] **Middleware (extended)**: Oracle WebLogic, Nginx, Apache HTTP Server
- [ ] **OS/Unix**: HP-UX, IBM AIX, Oracle Solaris

## Known Issues / Maintenance

- [ ] Shared venv (`shared-venv/`) must be provisioned on each new server deployment -- not committed to git
- [ ] Windows Server collector relies on manual WSUS/Microsoft Security Updates RSS -- consider automating
- [ ] Quarterly archive auto-check threshold tuning (currently fires at 30-day inactivity)
