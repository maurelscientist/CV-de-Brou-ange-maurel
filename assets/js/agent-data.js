/* =========================================================
   AGENT IA — BASE DE CONNAISSANCES (PORTFOLIO MAUREL BROU)
   Contenu réel extrait du portfolio. Aucune hallucination :
   l'agent ne répond qu'à partir de ces données.
   ========================================================= */
window.AGENT_KNOWLEDGE = {
  profil: {
    nom: "Brou Amoikon Richard Ange-Maurel",
    surnom: "Ange-Maurel",
    role: "Étudiant en MIAGE, développeur web & mobile, passionné de Business Intelligence et de révolutions numériques.",
    bio: "Aventurier MIAGE avec un flair pour le code et une passion pour les révolutions numériques. Spécialiste Business Intelligence, il conçoit des sites web, applications mobiles et solutions data sur mesure.",
    etudes: [
      "MIAGE (Méthodes Informatiques Appliquées à la Gestion des Entreprises) — cursus en cours.",
      "2 diplômes obtenus à ce jour (voir section Parcours)."
    ],
    competences: [
      "Programmation (web & mobile)",
      "Bases de données & SQL",
      "Analyse de données & Business Intelligence",
      "UI/UX design",
      "Gestion de projet informatique",
      "Automatisation des processus",
      "Développement d'applications (web & mobile)",
      "Back-end (API, architecture, sécurité)",
      "IA & outils modernes (Claude, Cursor, Copilot, ChatGPT, Supabase, Firebase…)"
    ],
    technologies: [
      "HTML / CSS / JavaScript",
      "TypeScript",
      "React / Next.js",
      "Flutter (mobile)",
      "Node.js",
      "Supabase / Firebase",
      "PostgreSQL",
      "Bootstrap, Tailwind CSS",
      "Outils IA : Claude, Cursor, GitHub Copilot, ChatGPT, Hugging Face"
    ],
    certifications: [
      "Certificat « Learn Prompting » (voir section AI Tools / certificat affiché)"
    ],
    reseaux: {
      linkedin: "Disponible via le footer du portfolio",
      github: "Disponible via le footer du portfolio",
      email: "maurelbrou040@gmail.com"
    },
    disponibilites: "Ouvert aux missions freelance, projets académiques, stages et partenariats. Disponible 24h/24 via l'agent IA."
  },

  services: [
    {
      titre: "Développement d'applications",
      desc: "Conception de sites web et applications mobiles, automatisation des processus et optimisation de la gestion pour des solutions sur mesure.",
      details: ["Sites vitrines & e-commerce", "Applications mobiles iOS / Android", "Automatisation de processus"]
    },
    {
      titre: "Business Intelligence",
      desc: "Tableaux de bord, analyse de données et aide à la décision pour transformer vos données brutes en leviers stratégiques.",
      details: ["Dashboards interactifs", "Analyse & visualisation", "Aide à la décision"]
    },
    {
      titre: "Back-end Development",
      desc: "API performantes, bases de données robustes, sécurité renforcée et architecture scalable pour des fondations solides.",
      details: ["API RESTful & GraphQL", "Architecture & sécurité", "Performance & scalabilité"]
    }
  ],

  projets: [
    {
      nom: "Previsi-Q",
      tag: "Web Platform · BI",
      desc: "Plateforme ivoirienne de prévisions financières et d'intelligence économique destinée aux PME de l'UEMOA. Aide les entrepreneurs à anticiper et décider.",
      features: ["Prévisions financières", "Intelligence économique", "Ciblé PME UEMOA"],
      url: "projet-previsiq.html",
      site: "https://previsi-q.com"
    },
    {
      nom: "UPB Connect",
      tag: "Mobile App · Flutter",
      desc: "Application mobile pour étudiants de l'Université Polytechnique de Bingerville — accès aux cours, actualités universitaires et vie du campus. Projet scolaire.",
      features: ["Consultation des cours", "Actualités universitaires", "Expérience étudiante"],
      url: "projet-upb-connect.html"
    },
    {
      nom: "Virtual Car Controller",
      tag: "Mobile App · Bluetooth / IoT",
      desc: "Application innovante permettant de diriger n'importe quelle voiture équipée du module Bluetooth HC-05. Interface moderne et intuitive, contrôle de trois manières.",
      features: ["Joystick virtuel pour la direction et la vitesse", "Commandes vocales mains libres", "Interface tactile précise"],
      url: "projet-virtual-car-controller.html"
    },
    {
      nom: "Orange Success",
      tag: "Design Sprint · Inclusion Numérique",
      desc: "Projet du Design Sprint universitaire en Côte d'Ivoire. Permet aux étudiants d'accéder à des avantages sur les pass internet Orange pour suivre leurs cours en ligne. Favorise l'inclusion numérique et la réussite universitaire.",
      features: ["Accès simplifié aux avantages Orange", "Soutien à la continuité des études", "Inclusion numérique et réussite académique"],
      url: "projet-orange-success.html",
      site: "https://orange-success-ci.netlify.app/"
    },
    {
      nom: "Ornifly",
      tag: "Web App · Booking",
      desc: "Site web de réservation de billets d'avion avec recherche, consultation et réservation en ligne. Interface claire pour un parcours fluide. Projet scolaire.",
      features: ["Recherche de vols", "Réservation en ligne", "Gestion des billets"],
      url: "projet-ornifly.html"
    }
  ],

  faq: [
    { q: "Qui suis-je ?", r: "Je suis étudiant en MIAGE, spécialisé dans le développement web et mobile, avec une passion pour la création de solutions numériques adaptées aux besoins des entreprises." },
    { q: "Quels services je propose ?", r: "Développement d'applications, administration systèmes et réseaux, business intelligence, automatisation des processus et gestion de projets informatiques." },
    { q: "Quels projets ai-je réalisés ?", r: "Ornifly, UPB Connect, Virtual Car Controller, Orange Success, Previsi-Q et divers projets académiques et professionnels." },
    { q: "Quelles sont mes compétences clés ?", r: "Programmation, bases de données, analyse de données, UI/UX et gestion de projet." },
    { q: "Comment me contacter ?", r: "Via la section contact du portfolio, par email ou LinkedIn." }
  ],

  contact: {
    email: "maurelbrou040@gmail.com",
    linkedin: "Via le footer du portfolio",
    github: "Via le footer du portfolio",
    note: "Formulaire de contact disponible en bas du portfolio (section footer / newsletter)."
  },

  cv: {
    nomFichier: "BROU ANGE-MAUREL.pdf",
    chemin: "CV/BROU ANGE-MAUREL.pdf",
    note: "CV disponible au téléchargement dans le portfolio."
  },

  lynda: {
    nom: "Lynda",
    role: "Assistante IA du portfolio de Maurel Brou (Brou Amoikon Richard Ange-Maurel).",
    origine: "Au départ, Maurel cherchait un nom pour son projet de base. Il hésitait entre « Lynda » et « Geko.ai ». Il a finalement demandé à l'une de ses sœurs de trouver un nom pour le projet, et celle-ci a proposé « Lynda » — qui est en réalité l'un des prénoms de cette sœur. Ce prénom lui a plu beaucoup plus que les autres options, et c'est ainsi que l'assistante a hérité du nom « Lynda ».",
    alternativesEnvisagees: ["Geko.ai"],
    note: "Si un utilisateur demande pourquoi l'assistante s'appelle Lynda, ou d'où vient ce nom, raconte cette histoire de façon naturelle et chaleureuse."
  }
};
