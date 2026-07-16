/* =========================================================
   PROJETS PAGE — Animations & Interactions
   ========================================================= */

(function () {
    'use strict';

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

    /* ---------- Year in footer ---------- */
    const yearEl = document.getElementById('currentYear');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* ---------- GSAP — Hero entrance & parallax ---------- */
    if (typeof gsap !== 'undefined') {
        gsap.registerPlugin(ScrollTrigger);

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (!reduceMotion) {
            /* Hero entrance */
            gsap.from('.projects-hero-eyebrow', {
                opacity: 0, y: 20, duration: 0.8, delay: 0.1, ease: 'power3.out'
            });
            gsap.from('.projects-hero-title', {
                opacity: 0, y: 40, duration: 1.0, delay: 0.25, ease: 'power3.out'
            });
            gsap.from('.projects-hero-subtitle', {
                opacity: 0, y: 30, duration: 0.9, delay: 0.45, ease: 'power3.out'
            });
            gsap.from('.projects-hero-scroll', {
                opacity: 0, duration: 0.8, delay: 1.0, ease: 'power2.out'
            });

            /* Parallax on hero bg + orbs */
            gsap.to('.projects-hero-bg', {
                yPercent: 30,
                ease: 'none',
                scrollTrigger: {
                    trigger: '.projects-hero',
                    start: 'top top',
                    end: 'bottom top',
                    scrub: true
                }
            });
            gsap.to('.projects-hero-orb.orb-1', {
                yPercent: -40,
                ease: 'none',
                scrollTrigger: {
                    trigger: '.projects-hero',
                    start: 'top top',
                    end: 'bottom top',
                    scrub: true
                }
            });
            gsap.to('.projects-hero-orb.orb-2', {
                yPercent: 50,
                ease: 'none',
                scrollTrigger: {
                    trigger: '.projects-hero',
                    start: 'top top',
                    end: 'bottom top',
                    scrub: true
                }
            });

            /* Project section cards stagger */
            gsap.utils.toArray('.project-section-card').forEach((card, i) => {
                gsap.from(card, {
                    scrollTrigger: { trigger: card, start: 'top 88%' },
                    opacity: 0,
                    y: 40,
                    duration: 0.7,
                    delay: (i % 4) * 0.08,
                    ease: 'power3.out'
                });
            });

            /* Video cards stagger */
            gsap.utils.toArray('.video-card').forEach((card, i) => {
                gsap.from(card, {
                    scrollTrigger: { trigger: card, start: 'top 88%' },
                    opacity: 0,
                    y: 30,
                    duration: 0.7,
                    delay: i * 0.1,
                    ease: 'power3.out'
                });
            });

            /* Project detail head reveal */
            gsap.utils.toArray('.project-detail-head').forEach((head) => {
                gsap.from(head.querySelectorAll('.project-detail-num, .project-detail-title, .project-detail-desc, .project-detail-meta, .project-detail-collab'), {
                    scrollTrigger: { trigger: head, start: 'top 85%' },
                    opacity: 0,
                    y: 25,
                    duration: 0.7,
                    stagger: 0.1,
                    ease: 'power3.out'
                });
            });

            /* Wave divider reveal */
            gsap.from('.newsletter-divider svg', {
                scrollTrigger: { trigger: '.newsletter-divider', start: 'top 95%' },
                opacity: 0,
                y: -30,
                duration: 1,
                ease: 'power2.out'
            });

            /* Newsletter reveal */
            gsap.from('.newsletter-intro > *', {
                scrollTrigger: { trigger: '.newsletter-card', start: 'top 85%' },
                opacity: 0,
                y: 30,
                duration: 0.7,
                stagger: 0.1,
                ease: 'power3.out'
            });
            gsap.from('.newsletter-form', {
                scrollTrigger: { trigger: '.newsletter-form', start: 'top 88%' },
                opacity: 0,
                y: 40,
                duration: 0.8,
                ease: 'power3.out'
            });
        }
    }

    /* ---------- Newsletter form ---------- */
    const form = document.getElementById('newsletterForm');
    const status = document.getElementById('newsletterStatus');

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('newsletterName').value.trim();
            const email = document.getElementById('newsletterEmail').value.trim();
            const message = document.getElementById('newsletterMessage').value.trim();

            if (!name || !email || !message) {
                status.textContent = '> Veuillez remplir tous les champs.';
                status.classList.remove('success');
                return;
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                status.textContent = '> Adresse email invalide.';
                status.classList.remove('success');
                return;
            }

            const btn = form.querySelector('button[type="submit"]');
            const originalHtml = btn.innerHTML;
            btn.innerHTML = '<span>Envoi...</span><i class="bi bi-hourglass-split"></i>';
            btn.disabled = true;

            setTimeout(() => {
                status.textContent = '> Merci ' + name + ' ! Votre message a bien été envoyé.';
                status.classList.add('success');
                form.reset();
                btn.innerHTML = originalHtml;
                btn.disabled = false;
                setTimeout(() => {
                    status.textContent = '';
                    status.classList.remove('success');
                }, 6000);
            }, 1100);
        });
    }

    /* ---------- AOS refresh after load ---------- */
    window.addEventListener('load', () => {
        if (typeof AOS !== 'undefined') AOS.refresh();
        if (typeof ScrollTrigger !== 'undefined') ScrollTrigger.refresh();
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

})();
