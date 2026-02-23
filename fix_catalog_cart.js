const fs = require('fs');
let html = fs.readFileSync('public/catalogo.html', 'utf8');

const drawerHtml = 
    <!-- CART DRAWER -->
    <div id="cart-backdrop" class="fixed inset-0 z-[300] hidden bg-slate-950/80 backdrop-blur-sm" onclick="toggleCart()"></div>
    <div id="cart-drawer" class="fixed top-0 right-0 h-full w-full sm:w-[450px] bg-slate-900 border-l border-white/5 shadow-2xl z-[400] flex flex-col translate-x-full transition-transform duration-300">
        <div class="flex items-center justify-between p-6 border-b border-white/5">
            <h2 class="text-xl font-black text-white flex items-center gap-3">
                <i data-lucide="shopping-bag" class="text-indigo-400"></i> Mi Carrito
            </h2>
            <button onclick="toggleCart()" class="text-slate-400 hover:text-white transition">
                <i data-lucide="x" class="w-6 h-6"></i>
            </button>
        </div>
        <div id="cart-items-container" class="flex-1 overflow-y-auto p-6 flex flex-col gap-4"></div>
        <div class="p-6 bg-slate-950 border-t border-white/5">
            <div class="flex justify-between items-center mb-4 text-sm font-bold text-slate-400">
                <span>Subtotal (MXN)</span>
                <span id="cart-subtotal" class="text-white text-lg">.00</span>
            </div>
            <button onclick="proceedToCheckout()" class="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-black uppercase tracking-widest text-sm py-4 rounded-2xl shadow-lg transition-transform hover:scale-[1.02]">
                Procesar Pago Seguro
            </button>
        </div>
    </div>
;

const cartJs = 
        let cart = [];
        
        function toggleCart() {
            const drawer = document.getElementById('cart-drawer');
            const backdrop = document.getElementById('cart-backdrop');
            
            if (drawer.style.transform === 'translateX(0px)' || drawer.classList.contains('translate-x-0')) {
                drawer.style.transform = 'translateX(100%)';
                drawer.classList.remove('translate-x-0');
                drawer.classList.add('translate-x-full');
                backdrop.classList.add('hidden');
                document.body.style.overflow = 'auto';
            } else {
                drawer.style.transform = 'translateX(0px)';
                drawer.classList.remove('translate-x-full');
                drawer.classList.add('translate-x-0');
                backdrop.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
                renderCart();
            }
        }

        function addToCartStatic(sku, name, price, vendor, image) {
            price = parseFloat(price);
            const existingItem = cart.find(item => item.sku === sku);
            if (existingItem) {
                existingItem.quantity += 1;
            } else {
                cart.push({
                    sku: sku,
                    name: name,
                    price: price,
                    vendor: vendor,
                    image: image,
                    stock: 99, // Static catalogs assume infinity stock for now
                    quantity: 1
                });
            }
            updateCartBadges();
            toggleCart();
        }

        function removeFromCart(sku) {
            cart = cart.filter(item => item.sku !== sku);
            updateCartBadges();
            renderCart();
        }

        function updateItemQuantity(sku, delta) {
            const item = cart.find(i => i.sku === sku);
            if (!item) return;
            const newQuantity = item.quantity + delta;
            if (newQuantity <= 0) {
                removeFromCart(sku);
            } else {
                item.quantity = newQuantity;
                renderCart();
                updateCartBadges();
            }
        }

        function updateCartBadges() {
            const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
            const desktopBadge = document.getElementById('cart-badge');
            const mobileBadge = document.getElementById('mobile-cart-badge');
            
            [desktopBadge, mobileBadge].forEach(badge => {
                if (badge) {
                    badge.textContent = totalItems;
                    if (totalItems > 0) {
                        badge.classList.remove('scale-0');
                        badge.classList.add('scale-100');
                    } else {
                        badge.classList.remove('scale-100');
                        badge.classList.add('scale-0');
                    }
                }
            });
            // Save state
            localStorage.setItem('pandishu_cart', JSON.stringify(cart));
        }

        function renderCart() {
            const container = document.getElementById('cart-items-container');
            const subtotalEl = document.getElementById('cart-subtotal');
            
            if (cart.length === 0) {
                container.innerHTML = \<div class="text-center py-20 text-slate-500"><i data-lucide="shopping-cart" class="w-12 h-12 mx-auto mb-4 opacity-50"></i><p>Tu carrito está vacío</p></div>\;
                subtotalEl.textContent = '.00';
                lucide.createIcons();
                return;
            }
            
            let subtotal = 0;
            container.innerHTML = cart.map(item => {
                const itemTotal = item.price * item.quantity;
                subtotal += itemTotal;
                return \
                <div class="bg-slate-800/80 rounded-xl p-4 border border-white/5 flex gap-4 relative">
                    <button onclick="removeFromCart('\')" class="absolute -top-2 -right-2 bg-slate-700 hover:bg-rose-500 text-white rounded-full p-1 transition-colors z-10"><i data-lucide="x" class="w-3 h-3"></i></button>
                    <div class="flex-1">
                        <span class="text-[9px] font-bold uppercase tracking-widest text-slate-500">\</span>
                        <h4 class="text-white text-xs font-bold leading-tight mb-2 line-clamp-2">\</h4>
                        <div class="flex items-center justify-between mt-3">
                            <div class="flex items-center bg-slate-900 rounded-lg p-1 border border-white/10">
                                <button onclick="updateItemQuantity('\', -1)" class="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-white"><i data-lucide="minus" class="w-3 h-3"></i></button>
                                <span class="text-xs font-bold text-white w-6 text-center">\</span>
                                <button onclick="updateItemQuantity('\', 1)" class="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-white"><i data-lucide="plus" class="w-3 h-3"></i></button>
                            </div>
                            <span class="text-indigo-300 font-black text-sm">$\</span>
                        </div>
                    </div>
                </div>\;
            }).join('');
            subtotalEl.textContent = \$\\;
            lucide.createIcons();
        }

        function proceedToCheckout() {
            if (cart.length === 0) return alert("Agrega productos al carrito.");
            localStorage.setItem('pandishu_cart', JSON.stringify(cart));
            window.location.href = 'checkout';
        }

        // Init Cart
        window.addEventListener('DOMContentLoaded', () => {
            try {
                const savedCart = localStorage.getItem('pandishu_cart');
                if (savedCart) {
                    cart = JSON.parse(savedCart);
                    updateCartBadges();
                }
            } catch (e) { console.error(e); }
        });
;

// Insert Drawer HTML before Footer
if (!html.includes('id="cart-drawer"')) {
    html = html.replace('<!-- Footer -->', drawerHtml + '\n\n    <!-- Footer -->');
}

// Insert JS logic before closing script tag
if (!html.includes('addToCartStatic')) {
    html = html.replace('lucide.createIcons();', 'lucide.createIcons();\n' + cartJs);
}

// Add Desktop Nav Cart Button
if (!html.includes('id="cart-badge"')) {
    html = html.replace('<!-- Highlighted Tienda Link -->', 
        \<button onclick="toggleCart()" class="relative bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/30 text-indigo-400 p-2 rounded-xl transition-all mr-2">
            <i data-lucide="shopping-bag" class="w-5 h-5"></i>
            <span id="cart-badge" class="absolute -top-2 -right-2 bg-rose-500 text-white text-[9px] font-black w-5 h-5 flex items-center justify-center rounded-full scale-0 transition-transform">0</span>
        </button>\n                <!-- Highlighted Tienda Link -->\
    );
}

// Add Mobile Nav Cart Button
if (!html.includes('id="mobile-cart-badge"')) {
    html = html.replace('<button onclick="toggleMenu()"', 
        \<button onclick="toggleCart()" class="relative text-white p-2 rounded-xl border border-white/10 hover:border-indigo-500/50 transition bg-slate-800/50 mr-2 flex items-center justify-center">
            <i data-lucide="shopping-bag" class="w-5 h-5"></i>
            <span id="mobile-cart-badge" class="absolute -top-2 -right-2 bg-rose-500 text-white text-[9px] font-black w-5 h-5 flex items-center justify-center rounded-full scale-0 transition-transform">0</span>
        </button>\n            <button onclick="toggleMenu()"\
    );
}

// Replace Product Buttons
const productMap = [
    { target: 'Quiero%20el%20Deco%20X20.', call: \ddToCartStatic('CAT-DECO-X20', 'TP-Link Deco X20 (2-Pack)', 2499, 'TP-LINK', '')\ },
    { target: 'Quiero%20el%20Deco%20M4.', call: \ddToCartStatic('CAT-DECO-M4', 'TP-Link Deco M4 (2-Pack)', 1599, 'TP-LINK', '')\ },
    { target: 'Quiero%20el%20Deco%20E4.', call: \ddToCartStatic('CAT-DECO-E4', 'TP-Link Deco E4 (2-Pack)', 1299, 'TP-LINK', '')\ },
    { target: 'Quiero%20la%20Tapo%20C520WS.', call: \ddToCartStatic('CAT-TAPO-C520', 'Tapo C520WS Exterior', 1199, 'TP-LINK', '')\ },
    { target: 'Quiero%20la%20Tapo%20C210.', call: \ddToCartStatic('CAT-TAPO-C210', 'Tapo C210 (3MP)', 599, 'TP-LINK', '')\ },
    { target: 'Quiero%20la%20Tapo%20C200.', call: \ddToCartStatic('CAT-TAPO-C200', 'Tapo C200 (1080p)', 499, 'TP-LINK', '')\ },
];

productMap.forEach(p => {
    // Regex to match the anchor tag containing the target text
    const regex = new RegExp(\<a href="https://wa.me/[^"]*text=\" [^>]*>[\\s\\S]*?</a>\);
    html = html.replace(regex, \<button onclick="\" class="btn-buy text-white p-3 rounded-xl shadow-lg bg-indigo-600 hover:bg-indigo-500 transition-colors"><i data-lucide="shopping-cart" class="w-5 h-5"></i></button>\);
});

fs.writeFileSync('public/catalogo.html', html);
console.log('Catalogo HTML patched successfully!');
