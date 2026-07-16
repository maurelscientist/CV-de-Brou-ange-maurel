/* =========================================================
   MAIN JS — Portfolio Brou Amoikon Richard Ange-Maurel
   ========================================================= */

(function () {
    'use strict';

    /* ---------- Theme: light uniquement (mode sombre supprimé) ---------- */
    const root = document.documentElement;
    // Force le thème clair en permanence, sans tenir compte du système
    // ni d'un choix stocké, pour éviter tout affichage en mode sombre.
    root.setAttribute('data-theme', 'light');

    /* ---------- Year in footer ---------- */
    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* ---------- AOS init ---------- */
    if (typeof AOS !== 'undefined') {
        AOS.init({
            duration: 800,
            easing: 'ease-out-cubic',
            once: true,
            offset: 60,
            disable: function () {
                return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            }
        });
    }

    /* ---------- Navbar scroll effect ---------- */
    const nav = document.getElementById('mainNav');
    const handleScroll = () => {
        if (!nav) return;
        if (window.scrollY > 40) {
            nav.classList.add('scrolled');
        } else {
            nav.classList.remove('scrolled');
        }

        /* Active nav link based on section */
        const sections = document.querySelectorAll('section[id]');
        let current = '';
        sections.forEach(section => {
            const top = section.offsetTop - 120;
            if (window.scrollY >= top) {
                current = section.getAttribute('id');
            }
        });

        document.querySelectorAll('.navbar-nav .nav-link').forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === '#' + current) {
                link.classList.add('active');
            }
        });
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    /* ---------- Close mobile nav on link click ---------- */
    document.querySelectorAll('.navbar-nav .nav-link').forEach(link => {
        link.addEventListener('click', () => {
            const collapse = document.getElementById('navbarMain');
            if (collapse && collapse.classList.contains('show')) {
                const bsCollapse = bootstrap.Collapse.getInstance(collapse);
                if (bsCollapse) bsCollapse.hide();
            }
        });
    });

    /* ---------- Typed.js ---------- */
    if (typeof Typed !== 'undefined') {
        const typedEl = document.querySelector('.typed');
        if (typedEl) {
            // Récupère les phrases depuis data-typed-items (séparées par des virgules)
            const itemsAttr = typedEl.getAttribute('data-typed-items') || '';
            const strings = itemsAttr.split(',').map(s => s.trim()).filter(Boolean);
            new Typed('.typed', {
                strings: strings.length ? strings : ['Aventurier MIAGE.'],
                loop: true,
                typeSpeed: 60,
                backSpeed: 30,
                backDelay: 1800,
                smartBackspace: false,
                cursorChar: ''
            });
        }
    }

    /* ---------- GSAP — Hero entrance & micro interactions ---------- */
    if (typeof gsap !== 'undefined') {
        gsap.registerPlugin(ScrollTrigger);

        /* Hero entrance */
        gsap.from('.hero-greeting', { opacity: 0, y: 20, duration: 0.8, delay: 0.2, ease: 'power3.out' });
        gsap.from('.hero-firstname', { opacity: 0, y: 30, duration: 0.9, delay: 0.35, ease: 'power3.out' });
        gsap.from('.hero-lastname', { opacity: 0, y: 30, duration: 0.9, delay: 0.5, ease: 'power3.out' });
        gsap.from('.hero-subtitle', { opacity: 0, y: 20, duration: 0.8, delay: 0.7, ease: 'power3.out' });
        gsap.from('.hero-tagline', { opacity: 0, y: 20, duration: 0.8, delay: 0.85, ease: 'power3.out' });
        gsap.from('.hero-cta', { opacity: 0, y: 20, duration: 0.8, delay: 1.0, ease: 'power3.out' });
        gsap.from('.hero-meta', { opacity: 0, y: 20, duration: 0.8, delay: 1.15, ease: 'power3.out' });
        gsap.from('.hero-photo-frame', { opacity: 0, scale: 0.92, duration: 1.2, delay: 0.2, ease: 'power3.out' });

        /* Service cards stagger */
        gsap.utils.toArray('.service-card').forEach((card, i) => {
            gsap.from(card, {
                scrollTrigger: { trigger: card, start: 'top 85%' },
                opacity: 0,
                y: 40,
                duration: 0.8,
                delay: i * 0.1,
                ease: 'power3.out'
            });
        });
    }

    /* ---------- Skills bars — animate on scroll ---------- */
    const skillsSection = document.getElementById('skills');
    let skillsDone = false;

    const animateSkills = () => {
        if (skillsDone || !skillsSection) return;
        const rect = skillsSection.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.8) {
            skillsDone = true;
            document.querySelectorAll('.skill-fill').forEach(fill => {
                const target = fill.getAttribute('data-width');
                fill.style.width = target + '%';
            });
            document.querySelectorAll('.skill-pct').forEach(pct => {
                const target = parseInt(pct.getAttribute('data-target'), 10);
                let current = 0;
                const duration = 1400;
                const stepTime = 20;
                const steps = duration / stepTime;
                const increment = target / steps;
                const timer = setInterval(() => {
                    current += increment;
                    if (current >= target) {
                        current = target;
                        clearInterval(timer);
                    }
                    pct.textContent = Math.floor(current) + '%';
                }, stepTime);
            });
        }
    };

    window.addEventListener('scroll', animateSkills, { passive: true });
    if (skillsSection) animateSkills();

    /* ---------- Smooth scroll for in-page anchors ---------- */
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const target = this.getAttribute('href');
            if (target.length > 1) {
                const el = document.querySelector(target);
                if (el) {
                    e.preventDefault();
                    const offset = 70;
                    const top = el.getBoundingClientRect().top + window.pageYOffset - offset;
                    window.scrollTo({ top, behavior: 'smooth' });
                }
            }
        });
    });

    /* ---------- Reflow AOS after assets load ---------- */
    window.addEventListener('load', () => {
        if (typeof AOS !== 'undefined') AOS.refresh();
    });

    /* ---------- Autoplay videos on scroll ---------- */
    const initAutoPlayVideos = () => {
        const videos = document.querySelectorAll('.video-wrapper video');
        if (!videos.length || !('IntersectionObserver' in window)) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(({ target, isIntersecting }) => {
                const video = target;
                video.playsInline = true;
                video.muted = true;

                if (isIntersecting) {
                    if (video.paused) {
                        const playPromise = video.play();
                        if (playPromise !== undefined) {
                            playPromise.catch(() => {
                                /* Autoplay blocked by browser */
                            });
                        }
                    }
                } else {
                    if (!video.paused) {
                        video.pause();
                    }
                }
            });
        }, { threshold: 0.6 });

        videos.forEach(video => observer.observe(video));
    };

    initAutoPlayVideos();

    /* ---------- Splash screen ---------- */
    const splash = document.getElementById('splashScreen');
    if (splash) {
        const hideSplash = () => splash.classList.add('is-hidden');
        if (document.readyState === 'complete') {
            setTimeout(hideSplash, 600);
        } else {
            window.addEventListener('load', () => setTimeout(hideSplash, 600));
        }
        setTimeout(hideSplash, 2200);
    }

})();
