const fetch = require('node-fetch');

async function testCheckout() {
    const url = 'http://127.0.0.1:5001/pandishu-web-1d860/us-central1/createCheckoutSession';
    const payload = {
        items: [
            { sku: "MOCK-UBI-01", name: "Ubiquiti UniFi AC Pro AP", vendor: "UBIQUITI", quantity: 2, price: 149.99 },
            { sku: "MOCK-DEL-01", name: "Dell XPS 13", vendor: "DELL", quantity: 1, price: 1250.00 }
        ],
        customer: {
            name: "Test User",
            email: "test@example.com",
            phone: "5551234567",
            address: {
                street: "123 Test St",
                colonia: "Test Colonia",
                zip: "12345",
                city: "Test City",
                state: "CDMX"
            }
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        console.log("Checkout Response Status:", response.status);
        console.log("Checkout Response Data:", data);
    } catch (error) {
        console.error("Test failed:", error);
    }
}

testCheckout();
