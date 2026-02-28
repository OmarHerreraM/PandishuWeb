/**
 * Pandishú Centralized Tracking & Cookie Consent Module
 * Design: Dark Mode (#0f172a) + Neon Cyan accents.
 * Engine: GA4 (gtag.js)
 */

const GA_MEASUREMENT_ID = 'G-6VQC13MZ6E';

// Inyectar CSS Dinámico para el Banner
const injectBannerStyles = () => {
    const style = document.createElement('style');
    style.innerHTML = `
        #cookie-banner {
            position: fixed;
            bottom: 0;
            left: 0;
            width: 100%;
            background-color: #0f172a; /* Slate 900 */
            border-top: 1px solid #00FFFF; /* Neon Cyan */
            color: #f8fafc; /* Slate 50 */
            padding: 20px;
            box-shadow: 0 -4px 30px rgba(0, 255, 255, 0.15);
            z-index: 99999;
            transform: translateY(100%);
            transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: 'Plus Jakarta Sans', sans-serif;
            display: flex;
            justify-content: center;
        }
        #cookie-banner.visible {
            transform: translateY(0);
        }
        .cookie-container {
            max-w-7xl;
            display: flex;
            flex-direction: column;
            gap: 15px;
            max-width: 1200px;
            width: 100%;
        }
        @media (min-width: 768px) {
            .cookie-container {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
            }
        }
        .cookie-text {
            font-size: 14px;
            line-height: 1.5;
            color: #94a3b8; /* Slate 400 */
        }
        .cookie-text a {
            color: #00FFFF;
            text-decoration: underline;
            text-underline-offset: 3px;
        }
        .cookie-text a:hover {
            color: #fff;
        }
        .cookie-actions {
            display: flex;
            gap: 10px;
            flex-shrink: 0;
        }
        .btn-cookie {
            padding: 10px 20px;
            font-weight: 700;
            border-radius: 8px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .btn-cookie-accept {
            background-color: #00FFFF;
            color: #020617; /* Slate 950 */
            border: 1px solid #00FFFF;
        }
        .btn-cookie-accept:hover {
            background-color: #fff;
            border-color: #fff;
            box-shadow: 0 0 15px rgba(0, 255, 255, 0.4);
        }
        .btn-cookie-config {
            background-color: transparent;
            color: #00FFFF;
            border: 1px solid #00FFFF;
        }
        .btn-cookie-config:hover {
            background-color: rgba(0, 255, 255, 0.1);
        }
    `;
    document.head.appendChild(style);
};

// Construir e inyectar el Banner HTML
const renderCookieBanner = () => {
    if (document.getElementById('cookie-banner')) return;

    injectBannerStyles();

    const banner = document.createElement('div');
    banner.id = 'cookie-banner';
    banner.innerHTML = `
        <div class="cookie-container">
            <div class="cookie-text">
                En <strong>Pandishú</strong> utilizamos cookies estrictamente necesarias para el carrito de compras, así como Google Analytics 4 para mejorar tu experiencia de navegación, analizar el tráfico y personalizar nuestro catálogo de hardware y soluciones. Puedes consultar los detalles en nuestra <a href="cookies.html">Política de Cookies</a>.
            </div>
            <div class="cookie-actions">
                <button id="btn-cookie-deny" class="btn-cookie btn-cookie-config">Rechazar Analytics</button>
                <button id="btn-cookie-accept" class="btn-cookie btn-cookie-accept">Aceptar Todo</button>
            </div>
        </div>
    `;
    document.body.appendChild(banner);

    // Activar animación de subida
    setTimeout(() => banner.classList.add('visible'), 500);

    // Bind events
    document.getElementById('btn-cookie-accept').addEventListener('click', () => {
        handleConsentProcess('granted');
        hideBanner(banner);
    });

    document.getElementById('btn-cookie-deny').addEventListener('click', () => {
        handleConsentProcess('denied');
        hideBanner(banner);
    });
};

const hideBanner = (bannerElement) => {
    bannerElement.classList.remove('visible');
    setTimeout(() => {
        if (bannerElement.parentNode) {
            bannerElement.parentNode.removeChild(bannerElement);
        }
    }, 500);
};

// Inyectar gtag.js de Google
const loadGoogleAnalytics = () => {
    // Evitar carga duplicada
    if (document.getElementById('ga4-script')) return;

    const scriptObj = document.createElement("script");
    scriptObj.id = "ga4-script";
    scriptObj.type = "text/javascript";
    scriptObj.async = true;
    scriptObj.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(scriptObj);

    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    window.gtag = gtag; // expose to window for external access

    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, {
        'anonymize_ip': true,
        'cookie_flags': 'SameSite=None;Secure'
    });

    console.log("🟢 Pandishú Tracking: GA4 Inicializado");
};

// Procesar decisión del usuario
const handleConsentProcess = (decision) => {
    localStorage.setItem('pandishu_cookie_consent', decision);
    if (decision === 'granted') {
        loadGoogleAnalytics();
    } else {
        console.log("🔴 Pandishú Tracking: Analytics Rechazado por el usuario.");
        // Clear cookies if they previously accepted
        document.cookie.split(";").forEach(function (c) {
            if (c.includes('_ga') || c.includes('_gid')) {
                document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
            }
        });
    }
};

// Función global wrapper segura (no falla si gtag no existe)
window.pandishuTrack = function (eventName, eventParameters = {}) {
    const consent = localStorage.getItem('pandishu_cookie_consent');
    if (consent === 'granted' && typeof window.gtag === 'function') {
        window.gtag('event', eventName, eventParameters);
        console.log(`🔵 Tracked Event: ${eventName}`, eventParameters);
    } else {
        console.warn(`🟡 Skipped Event: ${eventName} (Consentimiento faltante o GA4 no cargado)`);
    }
};

// Iniciar Motor de Privacidad al cargar DOM
document.addEventListener("DOMContentLoaded", () => {
    const consent = localStorage.getItem('pandishu_cookie_consent');
    if (consent === 'granted') {
        loadGoogleAnalytics();
    } else if (consent !== 'denied') {
        // Ninguno se ha elegido, mostrar banner
        renderCookieBanner();
    }
});
