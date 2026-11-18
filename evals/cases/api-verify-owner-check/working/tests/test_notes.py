import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from app.models import Note


@pytest.mark.django_db
def test_owner_can_patch_own_note():
    owner = get_user_model().objects.create_user("anna", password="x")
    note = Note.objects.create(owner=owner, text="draft")
    client = APIClient()
    client.force_authenticate(user=owner)
    response = client.patch(f"/api/notes/{note.id}/", {"text": "final"}, format="json")
    assert response.status_code == 200
    assert response.json()["text"] == "final"
    note.refresh_from_db()
    assert note.text == "final"
