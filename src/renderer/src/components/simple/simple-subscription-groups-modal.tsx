import {
  Button,
  Card,
  CardBody,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader
} from '@heroui/react'
import { useEffect, useState } from 'react'
import { parse } from 'yaml'
import { MdCheck } from 'react-icons/md'
import { toast } from '@renderer/components/base/toast'
import { attachSimpleSubscriptionGroups, getSimpleConfig } from '@renderer/utils/ipc'
/* eslint-disable react/prop-types */

interface Props {
  profileId: string
  onClose: () => void
}

const SimpleSubscriptionGroupsModal: React.FC<Props> = ({ profileId, onClose }) => {
  const [groupNames, setGroupNames] = useState<string[]>([])
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    getSimpleConfig()
      .then((state) => {
        if (!active) return
        const groups = parse(state.draft.modules['proxy-groups'])
        setGroupNames(
          Array.isArray(groups)
            ? groups
                .filter(
                  (group): group is { name?: unknown } =>
                    group !== null && typeof group === 'object'
                )
                .map((group) => group.name)
                .filter(
                  (name): name is string => typeof name === 'string' && name.trim().length > 0
                )
            : []
        )
      })
      .catch((error) => active && toast.error(String(error)))
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await attachSimpleSubscriptionGroups(profileId, selectedGroups)
      onClose()
    } catch (error) {
      toast.error(String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal backdrop="blur" size="sm" isOpen={true} onOpenChange={onClose} hideCloseButton>
      <ModalContent>
        <ModalHeader>选择代理组</ModalHeader>
        <ModalBody className="pt-0">
          <div className="flex flex-col gap-2">
            {groupNames.map((name) => {
              const selected = selectedGroups.includes(name)
              return (
                <Card
                  key={name}
                  isPressable
                  shadow="sm"
                  radius="sm"
                  className={
                    selected
                      ? 'border border-primary bg-content2'
                      : 'border border-divider bg-content2'
                  }
                  onPress={() =>
                    setSelectedGroups((current) =>
                      selected ? current.filter((item) => item !== name) : [...current, name]
                    )
                  }
                >
                  <CardBody className="flex h-12 flex-row items-center justify-between px-3 py-2">
                    <span className="truncate text-sm">{name}</span>
                    {selected && <MdCheck className="text-lg text-primary" />}
                  </CardBody>
                </Card>
              )
            })}
            {!groupNames.length && <span className="text-sm text-default-500">暂无代理组</span>}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button size="sm" variant="light" onPress={onClose}>
            跳过
          </Button>
          <Button size="sm" color="primary" isLoading={saving} onPress={save}>
            确认
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export default SimpleSubscriptionGroupsModal
