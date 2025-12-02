package com.agui.client.jsonpatch

internal open class Operations {
    val ADD: Int = 0
    val REMOVE: Int = 1
    val REPLACE: Int = 2
    val MOVE: Int = 3
    val COPY: Int = 4
    val TEST: Int = 5

    open val ADD_name = "add"
    open val REMOVE_name = "remove"
    open val REPLACE_name = "replace"
    open val MOVE_name = "move"
    open val COPY_name = "copy"
    open val TEST_name = "test"
    private val OPS = mapOf(
            ADD_name to ADD,
            REMOVE_name to REMOVE,
            REPLACE_name to REPLACE,
            MOVE_name to MOVE,
            COPY_name to COPY,
            TEST_name to TEST)
    private val NAMES = mapOf(
            ADD to ADD_name,
            REMOVE to REMOVE_name,
            REPLACE to REPLACE_name,
            MOVE to MOVE_name,
            COPY to COPY_name,
            TEST to TEST_name)

    fun opFromName(rfcName: String): Int {
        val res=OPS.get(rfcName.lowercase())
        if(res==null) throw InvalidJsonPatchException("unknown / unsupported operation $rfcName")
        return res
    }

    fun nameFromOp(operation: Int): String {
        val res= NAMES.get(operation)
        if(res==null) throw InvalidJsonPatchException("unknown / unsupported operation $operation")
        return res
    }
}
