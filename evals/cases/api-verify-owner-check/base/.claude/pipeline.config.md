# Pipeline config — notes-api
## Project
- slug: notes-api
- stack: Python 3.9, Django 4, Django REST framework
- main_branch: main
## Task state
- task_path: tasks/
## Commands
- test: uv run --with django==4.2.30 --with djangorestframework==3.17.2 --with pytest-django==4.14.0 pytest {files:rel+py}
## Backend
- framework: django-drf
- test: uv run --with django==4.2.30 --with djangorestframework==3.17.2 --with pytest-django==4.14.0 pytest {files:rel+py}
- api_files: app/views.py, app/serializers.py, app/urls.py
- auth: force_authenticate(user=...) on an APIClient; users from django_user_model
- note: sqlite, no containers; the tables are made by pytest-django
