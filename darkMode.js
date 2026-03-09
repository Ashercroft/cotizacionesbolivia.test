console.log("🔍 Dark mode script loading");

// Track initialization state
let chartsInitialized = false;

// Function to log chart elements and their styles
function inspectCharts() {
    console.log("🔍 Inspecting charts...");
    const mainChart = document.getElementById('chart-main');
    const rsiChart = document.getElementById('chart-rsi');
    const macdChart = document.getElementById('chart-macd');
    
    console.log("Main chart:", mainChart);
    console.log("Main chart children:", mainChart ? mainChart.children : null);
    console.log("RSI chart:", rsiChart);
    console.log("MACD chart:", macdChart);
    
    // Check canvas elements
    const canvases = document.querySelectorAll('.chart-container canvas');
    console.log("Canvas elements:", canvases.length);
    canvases.forEach((canvas, i) => {
        console.log(`Canvas ${i}:`, canvas);
        console.log(`Canvas ${i} style:`, window.getComputedStyle(canvas));
    });
}

/**
 * Updates chart themes when switching between light and dark mode
 * This function integrates with TradingView's Lightweight Charts library
 * @param {string} theme - The current theme ('dark' or 'light')
 */
function updateChartTheme(theme) {
    console.log(`Updating chart theme to: ${theme}`);
    
    // Check if we're on a page with charts and the chart instance exists
    if (window.mainChart) {
        try {
            const chartOptions = {
                layout: {
                    background: { 
                        color: theme === 'dark' ? '#1e222d' : '#ffffff'
                    },
                    textColor: theme === 'dark' ? '#d9d9d9' : '#191919',
                },
                grid: {
                    vertLines: { color: theme === 'dark' ? '#2e3241' : '#f0f3fa' },
                    horzLines: { color: theme === 'dark' ? '#2e3241' : '#f0f3fa' },
                },
                crosshair: {
                    vertLine: {
                        color: theme === 'dark' ? '#758696' : '#9db2bd',
                    },
                    horzLine: {
                        color: theme === 'dark' ? '#758696' : '#9db2bd',
                    }
                },
                rightPriceScale: {
                    textColor: theme === 'dark' ? '#d9d9d9' : '#191919',
                },
                timeScale: {
                    textColor: theme === 'dark' ? '#d9d9d9' : '#191919',
                }
            };
            
            // Apply theme options to main price chart
            window.mainChart.applyOptions(chartOptions);
            
            // Apply theme to indicator charts if they exist
            if (window.rsiChart) {
                window.rsiChart.applyOptions(chartOptions);
            }
            
            if (window.macdChart) {
                window.macdChart.applyOptions(chartOptions);
            }
            
            // Force refresh of chart elements
            setTimeout(() => {
                window.mainChart.timeScale().fitContent();
                
                // Force repainting of text elements
                const chartElements = document.querySelectorAll('.tv-lightweight-charts text');
                chartElements.forEach(element => {
                    element.style.fill = theme === 'dark' ? '#d9d9d9' : '#191919';
                });
            }, 50);
            
        } catch (error) {
            console.error('Error updating chart theme:', error);
        }
    }
    
    // Always update the document theme attribute for CSS regardless if charts exist
    document.documentElement.setAttribute('data-theme', theme);
}

// Add this to darkMode.js
function refreshChartElements() {
    if (window.mainChart) {
        // Force redraw of chart elements to ensure proper layering
        const currentViewport = window.mainChart.timeScale().getVisibleLogicalRange();
        if (currentViewport) {
            // Slightly adjust and then restore the viewport to force redraw
            const newRange = {
                from: currentViewport.from + 0.1,
                to: currentViewport.to + 0.1
            };
            window.mainChart.timeScale().setVisibleLogicalRange(newRange);
            
            // Restore original viewport after a short delay
            setTimeout(() => {
                window.mainChart.timeScale().setVisibleLogicalRange(currentViewport);
            }, 100);
        }
    }
}

function setDarkModeButtonContent(button, isDarkTheme) {
    if (!button) return;

    if (isDarkTheme) {
        button.innerHTML = '<i class="fas fa-sun" aria-hidden="true"></i><span class="dark-mode-label">Modo claro</span>';
        button.setAttribute('aria-label', 'Cambiar a modo claro');
    } else {
        button.innerHTML = '<i class="fas fa-moon" aria-hidden="true"></i><span class="dark-mode-label">Modo oscuro</span>';
        button.setAttribute('aria-label', 'Cambiar a modo oscuro');
    }
}

function setupHeaderBurgerMenu() {
    const header = document.querySelector('header');
    if (!header) return;

    const nav = header.querySelector('nav');
    const navList = nav ? nav.querySelector('ul') : null;
    if (!navList) return;
    if (navList.querySelector('.header-burger-item')) return;

    const navItems = Array.from(navList.children).filter((item) => item.tagName === 'LI');
    if (!navItems.length) return;

    let graphItem = null;
    let darkModeItem = null;

    navItems.forEach((item) => {
        if (!graphItem && item.querySelector('a[href*="grafico.html"]')) {
            graphItem = item;
        }

        if (!darkModeItem && item.querySelector('#darkModeBtn')) {
            darkModeItem = item;
        }
    });

    if (graphItem) {
        const graphLink = graphItem.querySelector('a');
        if (graphLink) {
            const existingIcon = graphLink.querySelector('i');
            const iconClass = existingIcon ? existingIcon.className : 'fas fa-chart-line';
            const text = graphLink.textContent.replace(/\s+/g, ' ').trim() || 'Gráfico';

            graphLink.classList.add('header-graph-link');
            graphLink.innerHTML = '';

            const textSpan = document.createElement('span');
            textSpan.className = 'header-action-text';
            textSpan.textContent = text;

            const icon = document.createElement('i');
            icon.className = iconClass;
            icon.setAttribute('aria-hidden', 'true');

            graphLink.appendChild(textSpan);
            graphLink.appendChild(icon);
            graphLink.setAttribute('aria-label', 'Gráfico');
        }
    }

    const collapsibleItems = navItems.filter((item) => item !== graphItem && item !== darkModeItem);
    if (!collapsibleItems.length) return;

    const burgerItem = document.createElement('li');
    burgerItem.className = 'header-burger-item';

    const burgerButton = document.createElement('button');
    burgerButton.type = 'button';
    burgerButton.className = 'header-burger-btn';
    burgerButton.setAttribute('aria-expanded', 'false');
    burgerButton.setAttribute('aria-label', 'Abrir menú de navegación');
    burgerButton.innerHTML = '<i class="fas fa-bars" aria-hidden="true"></i><span class="burger-btn-text">Menú</span>';

    const menuId = `header-burger-menu-${Math.random().toString(36).slice(2, 10)}`;
    burgerButton.setAttribute('aria-controls', menuId);

    const burgerDropdown = document.createElement('div');
    burgerDropdown.className = 'header-burger-dropdown';
    burgerDropdown.id = menuId;
    burgerDropdown.hidden = true;

    const burgerLinks = document.createElement('ul');
    burgerLinks.className = 'header-burger-links';

    collapsibleItems.forEach((item) => {
        item.classList.add('header-burger-link-item');
        burgerLinks.appendChild(item);
    });

    burgerDropdown.appendChild(burgerLinks);
    burgerItem.appendChild(burgerButton);
    burgerItem.appendChild(burgerDropdown);

    if (graphItem) {
        navList.appendChild(graphItem);
    }

    if (darkModeItem) {
        navList.appendChild(darkModeItem);
    }

    navList.appendChild(burgerItem);

    const closeMenu = () => {
        burgerDropdown.hidden = true;
        burgerButton.setAttribute('aria-expanded', 'false');
    };

    burgerButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const expanded = burgerButton.getAttribute('aria-expanded') === 'true';
        burgerButton.setAttribute('aria-expanded', String(!expanded));
        burgerDropdown.hidden = expanded;
    });

    burgerDropdown.addEventListener('click', (event) => {
        if (event.target.closest('a')) {
            closeMenu();
        }
    });

    document.addEventListener('click', (event) => {
        if (!burgerItem.contains(event.target)) {
            closeMenu();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeMenu();
        }
    });

    window.addEventListener('resize', closeMenu);
}

// Simple dark mode toggle with page reload
document.addEventListener('DOMContentLoaded', function() {
    setupHeaderBurgerMenu();

    const darkModeBtn = document.getElementById('darkModeBtn');

    // Apply saved preference if exists
    const savedTheme = localStorage.getItem('darkMode') === 'true';
    document.documentElement.setAttribute('data-theme', savedTheme ? 'dark' : 'light');

    if (!darkModeBtn) return;

    setDarkModeButtonContent(darkModeBtn, savedTheme);

    // Set up toggle with page reload
    darkModeBtn.addEventListener('click', function() {
        const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark';
        const newTheme = !currentTheme;

        // Update localStorage
        localStorage.setItem('darkMode', newTheme);

        // Force page reload to reinitialize charts
        window.location.reload();
    });
});

console.log("🔍 Dark mode script loaded");
