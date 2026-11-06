# Processus de développement

## Qui peut lancer un développement ?

Tout membre de l'équipe dirigeante peut soumettre une demande d'évolution via Paperclip en créant une issue de type `request_evolution`. Les développements sont réalisés automatiquement par les agents Henri via la boucle de self-développement.

## Comment ça se déroule ?

1. Un responsable humain soumet et valide une demande d'évolution (issue Paperclip `request_evolution`).
2. Le **Methods Officer** (agent) analyse la demande, produit un plan et crée des child issues pour l'Engineer.
3. L'**Engineer** (agent) implémente les changements dans un sandbox isolé, puis commit et pousse sur une branche GitHub.
4. Le Methods Officer vérifie le diff, lance `pnpm verify` (CI) et ouvre une Pull Request.
5. Un **humain** valide et merge la PR, puis déclenche le déploiement.

## Mécanisme de validation

Avant l'ouverture de toute PR, le code doit passer :

```
corepack enable && pnpm install && pnpm verify
```

Ce pipeline exécute : lint + format:check + typecheck + tests unitaires et d'intégration.

Aucun merge automatique n'est autorisé — un humain doit toujours approuver.

## Tests

Tous les changements sont testés dans un sandbox Fly Sprite isolé via `pnpm verify`. Les tests unitaires et d'intégration font partie de ce pipeline.

## Déploiement

Le déploiement est déclenché manuellement par un humain après merge de la PR. Les agents ne peuvent pas déclencher un déploiement eux-mêmes.

## Revue du processus

Une revue du processus de développement a été effectuée le **2026-11-06**.
