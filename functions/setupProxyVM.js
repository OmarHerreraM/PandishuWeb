require('dotenv').config();
const compute = require('@google-cloud/compute');

async function createProxyVM() {
    const projectId = 'pandishu-web-1d860';
    const zone = 'us-central1-a';
    const vmName = 'ct-proxy-vm';

    console.log(`🚀 Iniciando creación de VM ${vmName} en ${zone}...`);

    const instancesClient = new compute.InstancesClient();
    const firewallsClient = new compute.FirewallsClient();

    const machineType = `zones/${zone}/machineTypes/e2-micro`;
    const sourceImage = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts';
    // The VPC network
    const networkName = `projects/${projectId}/global/networks/default`;

    // Secure Squid Startup script: allows all, but rely on GCP Firewall to restrict access
    const startupScript = `#! /bin/bash
apt-get update
apt-get install -y squid
sed -i 's/http_access deny all/http_access allow all/' /etc/squid/squid.conf
systemctl restart squid
    `;

    try {
        // 1. Create Firewall Rule (Allow Port 3128 from Internal VPC only)
        console.log('🛡️ Verificando regla de Firewall...');
        try {
            const [rule] = await firewallsClient.get({ project: projectId, firewall: 'allow-internal-proxy-3128' });
            console.log('   Regla de firewall ya existe.');
        } catch (e) {
            console.log('   Creando nueva regla de firewall allow-internal-proxy-3128...');
            const [operation] = await firewallsClient.insert({
                project: projectId,
                firewallResource: {
                    name: 'allow-internal-proxy-3128',
                    network: networkName,
                    direction: 'INGRESS',
                    allowed: [{ IPProtocol: 'tcp', ports: ['3128'] }],
                    sourceRanges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
                    targetTags: ['proxy-server']
                }
            });
            await operation.promise();
            console.log('   Regla de firewall creada con éxito.');
        }

        // 2. Create VM
        console.log('🖥️ Solicitando creación de la instancia de cómputo...');
        const [response] = await instancesClient.insert({
            project: projectId,
            zone,
            instanceResource: {
                name: vmName,
                machineType,
                disks: [{
                    initializeParams: { sourceImage, diskSizeGb: '10' },
                    autoDelete: true,
                    boot: true,
                }],
                networkInterfaces: [{
                    network: networkName,
                    accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }], // Temporary Ephemeral IP
                }],
                tags: { items: ['proxy-server'] }, // Applies the firewall rule
                metadata: {
                    items: [{ key: 'startup-script', value: startupScript }]
                }
            },
        });

        console.log(`⌛ Esperando a que la operación de VM finalice...`);
        let operation = response.latestResponse;
        const operationsClient = new compute.ZoneOperationsClient();

        while (operation.status !== 'DONE') {
            const [currentOp] = await operationsClient.wait({
                operation: operation.name,
                project: projectId,
                zone: operation.zone.split('/').pop(),
            });
            operation = currentOp;
        }

        console.log('✅ VM Creada exitosamente.');

        // Get details to find IPs
        const [instance] = await instancesClient.get({ project: projectId, zone, instance: vmName });
        const internalIp = instance.networkInterfaces[0].networkIP;
        const externalIp = instance.networkInterfaces[0].accessConfigs[0].natIP;

        console.log(`\n📌 Detalles del Proxy:`);
        console.log(`   - IP Interna (Para uso de Cloud Functions): ${internalIp}`);
        console.log(`   - IP Externa Temporal: ${externalIp}`);

    } catch (error) {
        console.error('❌ Error al crear la infraestructura:', error);
    }
}

createProxyVM();
